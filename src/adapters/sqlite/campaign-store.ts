import type Database from "better-sqlite3";
import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  type CampaignEvent,
  type CampaignSnapshot,
  type CampaignStore,
  type ExternalReference,
} from "../../application/ports/campaign-store.js";
import { consumeApproval as consumeDomainApproval, type Approval } from "../../domain/approval.js";
import type { Campaign, CampaignStatus } from "../../domain/campaign.js";
import type { Evidence } from "../../domain/evidence.js";
import type { QodoFinding } from "../../domain/quality-gate.js";
import { migrateCampaignStore } from "./migrate.js";

export { CampaignIdentityConflict, CampaignVersionConflict };

interface CampaignRow {
  id: string;
  repository: string;
  issue_number: number;
  issue_url: string;
  parent_session_id: string;
  lane: Campaign["lane"];
  status: CampaignStatus;
  qodo_iteration: number;
  version: number;
}

interface EvidenceRow {
  id: string;
  source_url: string;
  retrieved_at: string;
  observation: string;
  kind: Evidence["kind"];
}

interface EventRow {
  id: string;
  event_type: string;
  payload_json: string;
  occurred_at: string;
}

interface ApprovalRow {
  id: string;
  campaign_id: string;
  action: Approval["action"];
  action_digest: string;
  status: Approval["status"];
  issued_at: string;
  expires_at: string | null;
  consumed_at: string | null;
}

interface QodoFindingRow {
  id: string;
  severity: QodoFinding["severity"];
  status: QodoFinding["status"];
  summary: string;
  source_url: string | null;
  disposition: string | null;
}

interface ExternalReferenceRow {
  kind: ExternalReference["kind"];
  value: string;
}

export class SqliteCampaignStore implements CampaignStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
    migrateCampaignStore(database);
  }

  async create(campaign: Campaign): Promise<void> {
    assertCampaignQodoIteration(campaign.qodoIteration);
    if (!Number.isInteger(campaign.version) || campaign.version < 1) {
      throw new CampaignVersionConflict(campaign.id, 0);
    }
    const now = new Date().toISOString();
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO campaigns (
          id, repository, issue_number, issue_url, parent_session_id, lane,
          status, qodo_iteration, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        campaign.id,
        campaign.repository,
        campaign.issueNumber,
        campaign.issueUrl,
        campaign.parentSessionId,
        campaign.lane,
        campaign.status,
        campaign.qodoIteration,
        campaign.version,
        now,
        now,
      );
    })();
  }

  async get(id: string): Promise<CampaignSnapshot | undefined> {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM campaigns WHERE id = ?")
        .get(id) as CampaignRow | undefined;
      return row ? this.#snapshot(row) : undefined;
    })();
  }

  async findByIssue(repository: string, issueNumber: number): Promise<CampaignSnapshot | undefined> {
    return this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM campaigns WHERE repository = ? COLLATE NOCASE AND issue_number = ?")
        .get(repository, issueNumber) as CampaignRow | undefined;
      return row ? this.#snapshot(row) : undefined;
    })();
  }

  async update(campaign: Campaign, expectedVersion: number): Promise<void> {
    assertCampaignQodoIteration(campaign.qodoIteration);
    if (
      !Number.isInteger(expectedVersion) ||
      !Number.isInteger(campaign.version) ||
      campaign.version !== expectedVersion + 1
    ) {
      throw new CampaignVersionConflict(campaign.id, expectedVersion);
    }

    const update = this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM campaigns WHERE id = ?")
        .get(campaign.id) as CampaignRow | undefined;
      if (!existing || existing.version !== expectedVersion) {
        throw new CampaignVersionConflict(campaign.id, expectedVersion);
      }
      if (
        existing.repository !== campaign.repository ||
        existing.issue_number !== campaign.issueNumber ||
        existing.issue_url !== campaign.issueUrl ||
        existing.parent_session_id !== campaign.parentSessionId
      ) {
        throw new CampaignIdentityConflict(campaign.id);
      }

      const result = this.#database.prepare(`
        UPDATE campaigns
        SET lane = ?, status = ?, qodo_iteration = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        campaign.lane,
        campaign.status,
        campaign.qodoIteration,
        new Date().toISOString(),
        campaign.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CampaignVersionConflict(campaign.id, expectedVersion);
      }
    });
    update.immediate();
  }

  async listByStatus(status: CampaignStatus): Promise<readonly CampaignSnapshot[]> {
    return this.#database.transaction(() => {
      const rows = this.#database
        .prepare("SELECT * FROM campaigns WHERE status = ? ORDER BY created_at, id")
        .all(status) as CampaignRow[];
      return rows.map((row) => this.#snapshot(row));
    })();
  }

  async appendEvidence(campaignId: string, evidence: Evidence): Promise<void> {
    const retrievedAt = normalizeTimestamp(evidence.retrievedAt, "evidence retrievedAt");
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO campaign_evidence (
          id, campaign_id, source_url, retrieved_at, observation, kind
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        evidence.id,
        campaignId,
        evidence.sourceUrl,
        retrievedAt,
        evidence.observation,
        evidence.kind,
      );
    })();
  }

  async appendEvent(campaignId: string, event: CampaignEvent): Promise<void> {
    const occurredAt = normalizeTimestamp(event.occurredAt, "event occurredAt");
    this.#database.prepare(`
      INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, campaignId, event.eventType, JSON.stringify(event.payload), occurredAt);
  }

  async recordApproval(approval: Approval): Promise<void> {
    const issuedAt = normalizeTimestamp(approval.issuedAt, "approval issuedAt");
    const expiresAt = approval.expiresAt === undefined
      ? null
      : normalizeTimestamp(approval.expiresAt, "approval expiry");
    const consumedAt = approval.consumedAt === undefined
      ? null
      : normalizeTimestamp(approval.consumedAt, "approval consumedAt");
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO approvals (
          id, campaign_id, action, action_digest, status, issued_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval.id,
        approval.campaignId,
        approval.action,
        approval.actionDigest,
        approval.status,
        issuedAt,
        expiresAt,
        consumedAt,
      );
    })();
  }

  async consumeApproval(approvalId: string, actionDigest: string, consumedAt: string): Promise<Approval> {
    const canonicalConsumedAt = normalizeTimestamp(consumedAt, "approval consumedAt");
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(approvalId) as ApprovalRow | undefined;
      if (!row) {
        throw new Error(`Approval ${approvalId} does not exist`);
      }

      const consumed = consumeDomainApproval(mapApproval(row), actionDigest, canonicalConsumedAt);
      const result = this.#database.prepare(`
        UPDATE approvals
        SET status = 'consumed', consumed_at = ?
        WHERE id = ?
          AND action_digest = ?
          AND status = 'approved'
          AND consumed_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
      `).run(canonicalConsumedAt, approvalId, actionDigest, canonicalConsumedAt);
      if (result.changes !== 1) {
        throw new Error("Approval is not available");
      }
      return consumed;
    });
    return consume.immediate();
  }

  async recordQodoFinding(campaignId: string, iteration: number, finding: QodoFinding): Promise<void> {
    assertQodoFindingIteration(iteration);
    const result = this.#database.prepare(`
      INSERT INTO qodo_findings (
        id, campaign_id, severity, status, summary, source_url, disposition, iteration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, id) DO UPDATE SET
        severity = excluded.severity,
        status = excluded.status,
        summary = excluded.summary,
        source_url = excluded.source_url,
        disposition = excluded.disposition,
        iteration = excluded.iteration
      WHERE excluded.iteration >= qodo_findings.iteration
    `).run(
      finding.id,
      campaignId,
      finding.severity,
      finding.status,
      finding.summary,
      finding.sourceUrl ?? null,
      finding.disposition ?? null,
      iteration,
    );
    if (result.changes !== 1) {
      throw new Error(`Stale Qodo finding iteration for ${finding.id}`);
    }
  }

  async setExternalReference(campaignId: string, reference: ExternalReference): Promise<void> {
    this.#database.prepare(`
      INSERT INTO external_references (campaign_id, kind, value)
      VALUES (?, ?, ?)
      ON CONFLICT(campaign_id, kind, value) DO NOTHING
    `).run(campaignId, reference.kind, reference.value);
  }

  #snapshot(row: CampaignRow): CampaignSnapshot {
    const evidence = this.#database.prepare(`
      SELECT id, source_url, retrieved_at, observation, kind
      FROM campaign_evidence WHERE campaign_id = ? ORDER BY retrieved_at, id
    `).all(row.id) as EvidenceRow[];
    const events = this.#database.prepare(`
      SELECT id, event_type, payload_json, occurred_at
      FROM campaign_events
      WHERE campaign_id = ?
      ORDER BY occurred_at, id
    `).all(row.id) as EventRow[];
    const approvals = this.#database.prepare(`
      SELECT * FROM approvals WHERE campaign_id = ? ORDER BY issued_at, id
    `).all(row.id) as ApprovalRow[];
    const qodoFindings = this.#database.prepare(`
      SELECT id, severity, status, summary, source_url, disposition
      FROM qodo_findings WHERE campaign_id = ? ORDER BY iteration, id
    `).all(row.id) as QodoFindingRow[];
    const externalReferences = this.#database.prepare(`
      SELECT kind, value FROM external_references
      WHERE campaign_id = ? ORDER BY kind, value
    `).all(row.id) as ExternalReferenceRow[];

    return {
      campaign: mapCampaign(row),
      evidence: evidence.map(mapEvidence),
      events: events.map(mapEvent),
      approvals: approvals.map(mapApproval),
      qodoFindings: qodoFindings.map(mapQodoFinding),
      externalReferences,
    };
  }
}

function mapCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    repository: row.repository,
    issueNumber: row.issue_number,
    issueUrl: row.issue_url,
    parentSessionId: row.parent_session_id,
    lane: row.lane,
    status: row.status,
    qodoIteration: row.qodo_iteration,
    version: row.version,
  };
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    retrievedAt: row.retrieved_at,
    observation: row.observation,
    kind: row.kind,
  };
}

function mapEvent(row: EventRow): CampaignEvent {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new Error(`Invalid payload JSON for campaign event ${row.id}`, { cause: error });
  }
  return { id: row.id, eventType: row.event_type, payload, occurredAt: row.occurred_at };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    action: row.action,
    actionDigest: row.action_digest,
    status: row.status,
    issuedAt: row.issued_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
  };
}

function mapQodoFinding(row: QodoFindingRow): QodoFinding {
  return {
    id: row.id,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    ...(row.disposition === null ? {} : { disposition: row.disposition }),
  };
}

function assertCampaignQodoIteration(iteration: number): void {
  if (!Number.isInteger(iteration) || iteration < 0 || iteration > 3) {
    throw new TypeError("Invalid integer campaign Qodo iteration; expected 0 to 3");
  }
}

function assertQodoFindingIteration(iteration: number): void {
  if (!Number.isInteger(iteration) || iteration < 1 || iteration > 3) {
    throw new TypeError("Invalid integer Qodo finding iteration; expected 1 to 3");
  }
}

function normalizeTimestamp(timestamp: string, label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|([+-])(\d{2}):([0-5]\d))$/.exec(timestamp);
  if (!match) {
    throw new TypeError(`Invalid ${label} timestamp`);
  }

  const [, year, month, day, , , , , offsetHour, offsetMinute] = match;
  const numericMonth = Number(month);
  const numericDay = Number(day);
  const numericOffsetHour = offsetHour === undefined ? 0 : Number(offsetHour);
  const numericOffsetMinute = offsetMinute === undefined ? 0 : Number(offsetMinute);
  const daysInMonth = new Date(Date.UTC(Number(year), numericMonth, 0)).getUTCDate();
  if (
    numericMonth < 1 ||
    numericMonth > 12 ||
    numericDay < 1 ||
    numericDay > daysInMonth ||
    numericOffsetHour > 14 ||
    (numericOffsetHour === 14 && numericOffsetMinute !== 0)
  ) {
    throw new TypeError(`Invalid ${label} timestamp`);
  }

  const instant = Date.parse(timestamp);
  if (!Number.isFinite(instant)) {
    throw new TypeError(`Invalid ${label} timestamp`);
  }
  return new Date(instant).toISOString();
}
