import type Database from "better-sqlite3";
import {
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

export { CampaignVersionConflict };

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
    const row = this.#database.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as CampaignRow | undefined;
    return row ? this.#snapshot(row) : undefined;
  }

  async findByIssue(repository: string, issueNumber: number): Promise<CampaignSnapshot | undefined> {
    const row = this.#database
      .prepare("SELECT * FROM campaigns WHERE repository = ? AND issue_number = ?")
      .get(repository, issueNumber) as CampaignRow | undefined;
    return row ? this.#snapshot(row) : undefined;
  }

  async update(campaign: Campaign, expectedVersion: number): Promise<void> {
    this.#database.transaction(() => {
      const result = this.#database.prepare(`
        UPDATE campaigns
        SET repository = ?, issue_number = ?, issue_url = ?, parent_session_id = ?,
            lane = ?, status = ?, qodo_iteration = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        campaign.repository,
        campaign.issueNumber,
        campaign.issueUrl,
        campaign.parentSessionId,
        campaign.lane,
        campaign.status,
        campaign.qodoIteration,
        campaign.version,
        new Date().toISOString(),
        campaign.id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        throw new CampaignVersionConflict(campaign.id, expectedVersion);
      }
    })();
  }

  async listByStatus(status: CampaignStatus): Promise<readonly CampaignSnapshot[]> {
    const rows = this.#database
      .prepare("SELECT * FROM campaigns WHERE status = ? ORDER BY created_at, id")
      .all(status) as CampaignRow[];
    return rows.map((row) => this.#snapshot(row));
  }

  async appendEvidence(campaignId: string, evidence: Evidence): Promise<void> {
    this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO campaign_evidence (
          id, campaign_id, source_url, retrieved_at, observation, kind
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        evidence.id,
        campaignId,
        evidence.sourceUrl,
        evidence.retrievedAt,
        evidence.observation,
        evidence.kind,
      );
    })();
  }

  async appendEvent(campaignId: string, event: CampaignEvent): Promise<void> {
    this.#database.prepare(`
      INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.id, campaignId, event.eventType, JSON.stringify(event.payload), event.occurredAt);
  }

  async recordApproval(approval: Approval): Promise<void> {
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
        approval.issuedAt,
        approval.expiresAt ?? null,
        approval.consumedAt ?? null,
      );
    })();
  }

  async consumeApproval(approvalId: string, actionDigest: string, consumedAt: string): Promise<Approval> {
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(approvalId) as ApprovalRow | undefined;
      if (!row) {
        throw new Error(`Approval ${approvalId} does not exist`);
      }

      const consumed = consumeDomainApproval(mapApproval(row), actionDigest, consumedAt);
      const result = this.#database.prepare(`
        UPDATE approvals
        SET status = 'consumed', consumed_at = ?
        WHERE id = ?
          AND action_digest = ?
          AND status = 'approved'
          AND consumed_at IS NULL
          AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
      `).run(consumedAt, approvalId, actionDigest, consumedAt);
      if (result.changes !== 1) {
        throw new Error("Approval is not available");
      }
      return consumed;
    });
    return consume.immediate();
  }

  async recordQodoFinding(campaignId: string, iteration: number, finding: QodoFinding): Promise<void> {
    this.#database.prepare(`
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
      ORDER BY julianday(occurred_at), occurred_at, id
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
