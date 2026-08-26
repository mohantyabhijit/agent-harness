import type Database from "better-sqlite3";
import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  type CampaignEvent,
  type ChildResultRecord,
  type CampaignSnapshot,
  type CampaignStore,
  type ExternalActionClaim,
  type ExternalActionClaimRecord,
  type ExternalActionCompletionRecord,
  type ExternalActionOutcomeUnknownRecord,
  type ExternalActionReconciliationRecord,
  type ExternalReference,
} from "../../application/ports/campaign-store.js";
import {
  canonicalExternalActionJson,
  externalActionDigest,
  validateExternalActionPayload,
  type ExternalActionPayload,
} from "../../application/external-action.js";
import {
  consumeApproval as consumeDomainApproval,
  isApprovalActionAllowed,
  type Approval,
} from "../../domain/approval.js";
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

interface ExternalActionClaimRow {
  id: string;
  campaign_id: string;
  approval_id: string;
  action_digest: string;
  payload_json: string;
  current_commit_sha: string | null;
  claimed_campaign_version: number;
  claimed_campaign_status: CampaignStatus;
  status: ExternalActionClaim["status"];
  attempted_at: string;
  closed_at: string | null;
  disposition: NonNullable<ExternalActionClaim["disposition"]> | null;
  observed_canonical_head: string | null;
}

export class SqliteCampaignStore implements CampaignStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
    migrateCampaignStore(database);
  }

  async create(campaign: Campaign, initialEvent?: CampaignEvent): Promise<void> {
    assertCampaignQodoIteration(campaign.qodoIteration);
    if (!Number.isInteger(campaign.version) || campaign.version < 1) {
      throw new CampaignVersionConflict(campaign.id, 0);
    }
    const now = new Date().toISOString();
    const occurredAt = initialEvent === undefined
      ? undefined
      : normalizeTimestamp(initialEvent.occurredAt, "event occurredAt");
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
      if (initialEvent !== undefined && occurredAt !== undefined) {
        this.#database.prepare(`
          INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          initialEvent.id,
          campaign.id,
          initialEvent.eventType,
          JSON.stringify(initialEvent.payload),
          occurredAt,
        );
      }
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
      this.#assertNoBlockingExternalAction(campaign.id);
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

  async consumeApproval(
    approvalId: string,
    actionDigest: string,
    consumedAt: string,
    expectedCampaignVersion: number,
    expectedCampaignStatus: CampaignStatus,
  ): Promise<Approval> {
    const canonicalConsumedAt = normalizeTimestamp(consumedAt, "approval consumedAt");
    if (!Number.isInteger(expectedCampaignVersion) || expectedCampaignVersion < 1) {
      throw new CampaignVersionConflict("approval campaign", expectedCampaignVersion);
    }
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .prepare("SELECT * FROM approvals WHERE id = ?")
        .get(approvalId) as ApprovalRow | undefined;
      if (!row) {
        throw new Error(`Approval ${approvalId} does not exist`);
      }

      const campaign = this.#database
        .prepare("SELECT * FROM campaigns WHERE id = ?")
        .get(row.campaign_id) as CampaignRow | undefined;
      if (campaign === undefined || campaign.version !== expectedCampaignVersion) {
        throw new CampaignVersionConflict(row.campaign_id, expectedCampaignVersion);
      }
      if (
        campaign.status !== expectedCampaignStatus ||
        !isApprovalActionAllowed(row.action, campaign.status)
      ) {
        throw new Error("Campaign state does not allow this approval action");
      }
      this.#assertNoBlockingExternalAction(row.campaign_id);

      const consumed = consumeDomainApproval(mapApproval(row), actionDigest, canonicalConsumedAt);
      const result = this.#database.prepare(`
        UPDATE approvals
        SET status = 'consumed', consumed_at = ?
        WHERE id = ?
          AND action_digest = ?
          AND status = 'approved'
          AND consumed_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND EXISTS (
            SELECT 1 FROM campaigns
            WHERE campaigns.id = approvals.campaign_id
              AND campaigns.version = ?
              AND campaigns.status = ?
          )
      `).run(
        canonicalConsumedAt,
        approvalId,
        actionDigest,
        canonicalConsumedAt,
        expectedCampaignVersion,
        expectedCampaignStatus,
      );
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

  async claimExternalAction(campaignId: string, record: ExternalActionClaimRecord): Promise<ExternalActionClaim> {
    validateExternalActionPayload(record.payload);
    const consumedAt = normalizeTimestamp(record.consumedAt, "approval consumedAt");
    const occurredAt = normalizeTimestamp(record.attemptedEvent.occurredAt, "event occurredAt");
    if (externalActionDigest(record.payload) !== record.actionDigest) throw new Error("External action payload digest does not match claim");
    if (record.attemptedEvent.eventType !== "external_action_attempted") throw new Error("Invalid external action attempted event");
    assertExternalActionEventVersion(record.attemptedEvent.payload, record.expectedVersion, record.expectedVersion);
    const claim = this.#database.transaction(() => {
      this.#assertClaim(campaignId, record.expectedVersion, record.expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      const currentCommitSha = this.#currentCommit(campaignId);
      if (currentCommitSha !== record.expectedCurrentCommitSha) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      if (record.payload.action === "create_pr" && record.payload.commitSha !== currentCommitSha) throw new Error("External action commit does not match current campaign head");

      const approvalRow = this.#database.prepare("SELECT * FROM approvals WHERE id = ?").get(record.approvalId) as ApprovalRow | undefined;
      if (approvalRow === undefined || approvalRow.campaign_id !== campaignId || approvalRow.action !== record.payload.action || approvalRow.action_digest !== record.actionDigest) throw new Error("Approval does not match this external action");
      if (!isApprovalActionAllowed(approvalRow.action, record.expectedStatus)) throw new Error("Campaign state does not allow this approval action");
      consumeDomainApproval(mapApproval(approvalRow), record.actionDigest, consumedAt);
      const consumed = this.#database.prepare(`
        UPDATE approvals SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND campaign_id = ? AND action_digest = ? AND status = 'approved'
          AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      `).run(consumedAt, record.approvalId, campaignId, record.actionDigest, consumedAt);
      if (consumed.changes !== 1) throw new Error("Approval is not available");

      this.#database.prepare(`
        INSERT INTO external_action_claims (
          id, campaign_id, approval_id, action_digest, payload_json, current_commit_sha,
          claimed_campaign_version, claimed_campaign_status, status, attempted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(
        record.claimId, campaignId, record.approvalId, record.actionDigest,
        canonicalExternalActionJson(record.payload), currentCommitSha ?? null,
        record.expectedVersion, record.expectedStatus, consumedAt,
      );
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(
        record.attemptedEvent.id, campaignId, record.attemptedEvent.eventType,
        JSON.stringify(record.attemptedEvent.payload), occurredAt,
      );
      return this.#requiredExternalActionClaim(campaignId, record.claimId, "active");
    });
    return claim.immediate();
  }

  async completeExternalAction(campaignId: string, record: ExternalActionCompletionRecord): Promise<number> {
    const completedAt = normalizeTimestamp(record.completedAt, "external action completion");
    const occurredAt = normalizeTimestamp(record.completedEvent.occurredAt, "event occurredAt");
    if (record.newCommitSha !== undefined) assertCommitSha(record.newCommitSha);
    if (record.completedEvent.eventType !== "external_action_completed") throw new Error("Invalid external action completed event");
    const complete = this.#database.transaction(() => {
      const claim = this.#requiredExternalActionClaim(campaignId, record.claimId, "active");
      this.#assertClaim(campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
      if (this.#currentCommit(campaignId) !== claim.currentCommitSha) throw new Error("External action current head changed after claim");
      const payload = claim.payload;
      if (record.newCommitSha !== undefined && ((payload.action !== "push_branch" && payload.action !== "update_pr") || payload.commitSha !== record.newCommitSha)) throw new Error("External action completion commit does not match claimed payload");
      const current = this.#currentCommit(campaignId);
      const changed = record.newCommitSha !== undefined && record.newCommitSha !== current;
      const resultingVersion = claim.claimedCampaignVersion + (changed ? 1 : 0);
      assertExternalActionEventVersion(record.completedEvent.payload, claim.claimedCampaignVersion, resultingVersion);
      if (changed) {
        this.#replaceCommit(campaignId, record.newCommitSha);
        const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(completedAt, campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
        if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, claim.claimedCampaignVersion);
      }
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(
        record.completedEvent.id, campaignId, record.completedEvent.eventType,
        JSON.stringify(record.completedEvent.payload), occurredAt,
      );
      const closed = this.#database.prepare("UPDATE external_action_claims SET status = 'completed', closed_at = ? WHERE id = ? AND campaign_id = ? AND status = 'active'").run(completedAt, record.claimId, campaignId);
      if (closed.changes !== 1) throw new Error(`External action claim ${record.claimId} is stale`);
      return resultingVersion;
    });
    return complete.immediate();
  }

  async markExternalActionOutcomeUnknown(campaignId: string, record: ExternalActionOutcomeUnknownRecord): Promise<void> {
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (record.event.eventType !== "external_action_outcome_unknown") throw new Error("Invalid external action outcome event");
    const mark = this.#database.transaction(() => {
      this.#requiredExternalActionClaim(campaignId, record.claimId, "active");
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(
        record.event.id, campaignId, record.event.eventType, JSON.stringify(record.event.payload), occurredAt,
      );
      const changed = this.#database.prepare("UPDATE external_action_claims SET status = 'outcome_unknown' WHERE id = ? AND campaign_id = ? AND status = 'active'").run(record.claimId, campaignId);
      if (changed.changes !== 1) throw new Error(`External action claim ${record.claimId} is stale`);
    });
    mark.immediate();
  }

  async reconcileExternalAction(campaignId: string, record: ExternalActionReconciliationRecord): Promise<number> {
    const reconciledAt = normalizeTimestamp(record.reconciledAt, "external action reconciliation");
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (record.observedCanonicalHead !== undefined) assertCommitSha(record.observedCanonicalHead);
    if (record.event.eventType !== "external_action_reconciled") throw new Error("Invalid external action reconciliation event");
    const reconcile = this.#database.transaction(() => {
      this.#requiredExternalActionClaim(campaignId, record.claimId, "outcome_unknown");
      const campaign = this.#database.prepare("SELECT version, status FROM campaigns WHERE id = ?").get(campaignId) as Pick<CampaignRow, "version" | "status"> | undefined;
      if (campaign === undefined) throw new Error(`Campaign ${campaignId} does not exist`);
      const current = this.#currentCommit(campaignId);
      const changed = record.observedCanonicalHead !== undefined && record.observedCanonicalHead !== current;
      const resultingVersion = campaign.version + (changed ? 1 : 0);
      assertExternalActionEventVersion(record.event.payload, campaign.version, resultingVersion);
      if (changed) {
        this.#replaceCommit(campaignId, record.observedCanonicalHead);
        const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?").run(reconciledAt, campaignId, campaign.version);
        if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, campaign.version);
      }
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(
        record.event.id, campaignId, record.event.eventType, JSON.stringify(record.event.payload), occurredAt,
      );
      const closed = this.#database.prepare(`
        UPDATE external_action_claims SET status = 'reconciled', closed_at = ?, disposition = ?, observed_canonical_head = ?
        WHERE id = ? AND campaign_id = ? AND status = 'outcome_unknown'
      `).run(reconciledAt, record.disposition, record.observedCanonicalHead ?? null, record.claimId, campaignId);
      if (closed.changes !== 1) throw new Error(`External action claim ${record.claimId} is stale`);
      return resultingVersion;
    });
    return reconcile.immediate();
  }

  async replaceCurrentCommit(
    campaignId: string,
    commitSha: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number> {
    assertCommitSha(commitSha);
    if (!statusesAllowingIndependentCommitReplacement.has(expectedStatus)) throw new Error(`Campaign status ${expectedStatus} does not allow independent current commit replacement`);
    const replace = this.#database.transaction(() => {
      this.#assertClaim(campaignId, expectedVersion, expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      const current = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'commit'").get(campaignId) as { value: string } | undefined;
      if (current?.value === commitSha) return expectedVersion;
      this.#replaceCommit(campaignId, commitSha);
      const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(new Date().toISOString(), campaignId, expectedVersion, expectedStatus);
      if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, expectedVersion);
      return expectedVersion + 1;
    });
    return replace.immediate();
  }

  async recordChildResult(campaignId: string, record: ChildResultRecord): Promise<number> {
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (record.childSessionId.trim().length === 0) throw new Error("Invalid child session identifier");
    if (record.newCommitSha !== undefined) assertCommitSha(record.newCommitSha);
    const write = this.#database.transaction(() => {
      this.#assertClaim(campaignId, record.expectedVersion, record.expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      let resultingVersion = record.expectedVersion;
      if (record.newCommitSha !== undefined) {
        const current = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'commit'").get(campaignId) as { value: string } | undefined;
        if (current?.value !== record.newCommitSha) {
          this.#replaceCommit(campaignId, record.newCommitSha);
          const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(new Date().toISOString(), campaignId, record.expectedVersion, record.expectedStatus);
          if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
          resultingVersion += 1;
        }
      }
      assertChildEventVersion(record.event.payload, record.expectedVersion, resultingVersion);
      this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'child_session', ?) ON CONFLICT DO NOTHING").run(campaignId, record.childSessionId);
      this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'sandbox', ?) ON CONFLICT DO NOTHING").run(campaignId, record.childSessionId);
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)").run(record.event.id, campaignId, record.event.eventType, JSON.stringify(record.event.payload), occurredAt);
      return resultingVersion;
    });
    return write.immediate();
  }

  async setExternalReference(campaignId: string, reference: ExternalReference): Promise<void> {
    if (reference.kind === "commit") throw new Error("Current commit requires a versioned replacement");
    const write = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO external_references (campaign_id, kind, value)
        VALUES (?, ?, ?)
        ON CONFLICT(campaign_id, kind, value) DO NOTHING
      `).run(campaignId, reference.kind, reference.value);
    });
    write.immediate();
  }

  #assertClaim(campaignId: string, expectedVersion: number, expectedStatus: CampaignStatus): void {
    const campaign = this.#database.prepare("SELECT version, status FROM campaigns WHERE id = ?").get(campaignId) as Pick<CampaignRow, "version" | "status"> | undefined;
    if (campaign === undefined || campaign.version !== expectedVersion || campaign.status !== expectedStatus) throw new CampaignVersionConflict(campaignId, expectedVersion);
  }

  #assertNoBlockingExternalAction(campaignId: string): void {
    const blocking = this.#database.prepare("SELECT id FROM external_action_claims WHERE campaign_id = ? AND status IN ('active', 'outcome_unknown') LIMIT 1").get(campaignId) as { id: string } | undefined;
    if (blocking !== undefined) throw new Error("Campaign has a blocking external action claim");
  }

  #currentCommit(campaignId: string): string | undefined {
    const commits = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'commit'").all(campaignId) as { value: string }[];
    if (commits.length > 1) throw new Error("Campaign current commit is ambiguous");
    return commits[0]?.value;
  }

  #requiredExternalActionClaim(campaignId: string, claimId: string, status: ExternalActionClaim["status"]): ExternalActionClaim {
    const row = this.#database.prepare("SELECT * FROM external_action_claims WHERE id = ? AND campaign_id = ? AND status = ?").get(claimId, campaignId, status) as ExternalActionClaimRow | undefined;
    if (row === undefined) throw new Error(`External action claim ${claimId} is not ${status}`);
    return mapExternalActionClaim(row);
  }

  #replaceCommit(campaignId: string, commitSha: string): void {
    this.#database.prepare("DELETE FROM external_references WHERE campaign_id = ? AND kind = 'commit'").run(campaignId);
    this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run(campaignId, commitSha);
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
    const externalActionClaims = this.#database.prepare(`
      SELECT * FROM external_action_claims WHERE campaign_id = ? ORDER BY attempted_at, id
    `).all(row.id) as ExternalActionClaimRow[];

    return {
      campaign: mapCampaign(row),
      evidence: evidence.map(mapEvidence),
      events: events.map(mapEvent),
      approvals: approvals.map(mapApproval),
      qodoFindings: qodoFindings.map(mapQodoFinding),
      externalReferences,
      externalActionClaims: externalActionClaims.map(mapExternalActionClaim),
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

function mapExternalActionClaim(row: ExternalActionClaimRow): ExternalActionClaim {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new Error(`Invalid payload JSON for external action claim ${row.id}`, { cause: error });
  }
  validateExternalActionPayload(payload as ExternalActionPayload);
  return {
    id: row.id,
    campaignId: row.campaign_id,
    approvalId: row.approval_id,
    actionDigest: row.action_digest,
    payload: payload as ExternalActionPayload,
    ...(row.current_commit_sha === null ? {} : { currentCommitSha: row.current_commit_sha }),
    claimedCampaignVersion: row.claimed_campaign_version,
    claimedCampaignStatus: row.claimed_campaign_status,
    status: row.status,
    attemptedAt: row.attempted_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    ...(row.disposition === null ? {} : { disposition: row.disposition }),
    ...(row.observed_canonical_head === null ? {} : { observedCanonicalHead: row.observed_canonical_head }),
  };
}

function assertCampaignQodoIteration(iteration: number): void {
  if (!Number.isInteger(iteration) || iteration < 0 || iteration > 3) {
    throw new TypeError("Invalid integer campaign Qodo iteration; expected 0 to 3");
  }
}

function assertCommitSha(commitSha: string): void {
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Invalid current commit SHA");
}

function assertChildEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion ||
    !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion
  ) throw new Error("Child result event is not bound to the campaign version");
}

function assertExternalActionEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion ||
    !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion
  ) throw new Error("External action event is not bound to the campaign version");
}

const statusesAllowingIndependentCommitReplacement = new Set<CampaignStatus>([
  "policy_review", "coordination_pending", "preflight", "quarantined", "baseline", "implementation",
  "verification", "contribution_approval", "pull_request_open", "qodo_review", "human_escalation",
]);

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
