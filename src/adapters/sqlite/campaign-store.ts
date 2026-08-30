import type Database from "better-sqlite3";
import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  ApprovalIssuanceConflict,
  reservedCampaignEventTypes,
  type ApprovalIssuanceRecord,
  type ProposalApprovalIssuanceRecord,
  type CampaignEvent,
  type CampaignEventInput,
  type ChildResultRecord,
  type CampaignSnapshot,
  type CampaignStore,
  type ExternalActionClaim,
  type ExternalActionClaimRecord,
  type ExternalActionCompletionRecord,
  type ExternalActionOutcomeUnknownRecord,
  type ExternalActionReconciliationRecord,
  type ExternalActionStaleRecoveryRecord,
  type ExternalReference,
  type QodoReviewClaimRecord,
  type QodoEscalationRecord,
} from "../../application/ports/campaign-store.js";
import { currentApprovalProposal } from "../../application/approval-proposal.js";
import {
  canonicalExternalActionJson,
  externalActionDigest,
  isPullRequest,
  validateExternalActionPayload,
  type ExternalActionPayload,
} from "../../application/external-action.js";
import {
  consumeApproval as consumeDomainApproval,
  issueApproval as issueDomainApproval,
  isApprovalActionAllowed,
  type Approval,
} from "../../domain/approval.js";
import type { Campaign, CampaignStatus } from "../../domain/campaign.js";
import type { IssueBrief } from "../../domain/issue-brief.js";
import type { Evidence } from "../../domain/evidence.js";
import type { QodoFinding } from "../../domain/quality-gate.js";
import { parseQodoFinding } from "../../application/qodo-review-batch.js";
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
  sequence: number | null;
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
  proposal_id: string | null;
  expected_campaign_version: number | null;
  expected_campaign_status: CampaignStatus | null;
  expected_current_commit_sha: string | null;
  payload_json: string | null;
  active: 0 | 1;
  trusted_proposal_authority: 0 | 1;
}

interface QodoFindingRow {
  id: string;
  severity: QodoFinding["severity"];
  status: QodoFinding["status"];
  summary: string;
  source_url: string | null;
  body: string | null;
  path: string | null;
  line: number | null;
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
  lease_started_at: string;
  closed_at: string | null;
  disposition: NonNullable<ExternalActionClaim["disposition"]> | null;
  observed_canonical_head: string | null;
  repair_verification_receipt: string | null;
}

export class SqliteCampaignStore implements CampaignStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
    migrateCampaignStore(database);
  }

  async finalizeCampaign(campaignId: string, brief: IssueBrief, expectedVersion: number, event: CampaignEventInput): Promise<Campaign> {
    const operation = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as CampaignRow | undefined;
      if (row === undefined) throw new Error("Campaign does not exist");
      const requestedKey = isRecord(event.payload) ? event.payload.idempotencyKey : undefined;
      const priorRows = this.#database.prepare("SELECT payload_json FROM campaign_events WHERE campaign_id = ? AND event_type = 'campaign_finalized' ORDER BY sequence").all(campaignId) as { payload_json: string }[];
      const prior = priorRows.map((candidate) => parseJsonRecord(candidate.payload_json)).find((payload) => payload?.idempotencyKey === requestedKey);
      if (prior !== undefined) {
        if (prior.expectedVersion !== expectedVersion) throw new CampaignVersionConflict(campaignId, expectedVersion);
        return { ...row };
      }
      if (row.version !== expectedVersion || row.status !== "policy_review") throw new CampaignVersionConflict(campaignId, expectedVersion);
      const nextVersion = expectedVersion + 1;
      const updated = this.#database.prepare("UPDATE campaigns SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?").run("coordination_pending", nextVersion, new Date().toISOString(), campaignId, expectedVersion);
      if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, expectedVersion);
      const sequence = (this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM campaign_events WHERE campaign_id = ?").get(campaignId) as { sequence: number }).sequence + 1;
      const payload = isRecord(event.payload) ? { ...event.payload, brief } : { brief };
      this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at, sequence) VALUES (?, ?, ?, ?, ?, ?)").run(event.id, campaignId, "campaign_finalized", JSON.stringify(payload), normalizeTimestamp(event.occurredAt, "event occurredAt"), sequence);
      return { id: row.id, repository: row.repository, issue_number: row.issue_number, issue_url: row.issue_url, parent_session_id: row.parent_session_id, lane: row.lane, status: "coordination_pending" as const, qodo_iteration: row.qodo_iteration, version: nextVersion };
    });
    const result = operation.immediate();
    return { id: result.id, repository: result.repository, issueNumber: result.issue_number, issueUrl: result.issue_url, parentSessionId: result.parent_session_id, lane: result.lane, status: result.status, qodoIteration: result.qodo_iteration, version: result.version };
  }

  async create(campaign: Campaign, initialEvent?: CampaignEventInput): Promise<void> {
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
          INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at, sequence)
          VALUES (?, ?, ?, ?, ?, 1)
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

  async get(id: string, observedAt?: string): Promise<CampaignSnapshot | undefined> {
    const canonicalObservedAt = observedAt === undefined ? undefined : normalizeTimestamp(observedAt, "approval observation");
    const read = this.#database.transaction(() => {
      if (canonicalObservedAt !== undefined) {
        this.#database.prepare("UPDATE approvals SET active = 0 WHERE campaign_id = ? AND status = 'approved' AND active = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(id, canonicalObservedAt);
      }
      const row = this.#database
        .prepare("SELECT * FROM campaigns WHERE id = ?")
        .get(id) as CampaignRow | undefined;
      return row ? this.#snapshot(row) : undefined;
    });
    return canonicalObservedAt === undefined ? read() : read.immediate();
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

  async appendEvent(campaignId: string, event: CampaignEventInput): Promise<void> {
    if (reservedCampaignEventTypes.has(event.eventType)) throw new Error("Authoritative campaign event requires its guarded store operation");
    const occurredAt = normalizeTimestamp(event.occurredAt, "event occurredAt");
    this.#database.transaction(() => { this.#insertEvent(campaignId, event, occurredAt); }).immediate();
  }

  async recordApproval(approval: Approval): Promise<void> {
    this.#database.transaction(() => {
      this.#insertApproval({ ...approval, active: false, trustedProposalAuthority: false });
    })();
  }

  async issueApproval(record: ApprovalIssuanceRecord): Promise<Approval> {
    const key = record.idempotencyKey;
    if (key.length < 8 || key.length > 128) throw new ApprovalIssuanceConflict();
    const issue = this.#database.transaction(() => {
      this.#database.prepare("UPDATE approvals SET active = 0 WHERE campaign_id = ? AND status = 'approved' AND active = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(record.approval.campaignId, record.approval.issuedAt);
      const replay = this.#database.prepare(`
        SELECT approvals.* FROM approval_issuance_keys
        JOIN approvals ON approvals.id = approval_issuance_keys.approval_id
        WHERE approval_issuance_keys.campaign_id = ? AND approval_issuance_keys.idempotency_key = ?
      `).get(record.approval.campaignId, key) as ApprovalRow | undefined;
      if (replay !== undefined) {
        if (replay.action_digest !== record.approval.actionDigest || replay.action !== record.approval.action) throw new ApprovalIssuanceConflict();
        return mapApproval(replay);
      }
      const existing = this.#database.prepare("SELECT id FROM approvals WHERE campaign_id = ? AND action_digest = ? AND status = 'approved' AND active = 1").get(record.approval.campaignId, record.approval.actionDigest) as { id: string } | undefined;
      if (existing !== undefined) throw new ApprovalIssuanceConflict();
      const inactive = { ...record.approval, active: false, trustedProposalAuthority: false } as const;
      this.#insertApproval(inactive);
      this.#database.prepare("INSERT INTO approval_issuance_keys (campaign_id, idempotency_key, approval_id) VALUES (?, ?, ?)").run(record.approval.campaignId, key, record.approval.id);
      return inactive;
    });
    try { return issue.immediate(); } catch (error) {
      if (error instanceof ApprovalIssuanceConflict) throw error;
      if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) throw new ApprovalIssuanceConflict();
      throw error;
    }
  }

  async issueApprovalForProposal(record: ProposalApprovalIssuanceRecord): Promise<Approval> {
    if (record.idempotencyKey.length < 8 || record.idempotencyKey.length > 128) throw new ApprovalIssuanceConflict();
    const issue = this.#database.transaction(() => {
      const row = this.#database.prepare("SELECT * FROM campaigns WHERE id = ?").get(record.campaignId) as CampaignRow | undefined;
      if (row === undefined) throw new ApprovalIssuanceConflict();
      this.#database.prepare("UPDATE approvals SET active = 0 WHERE campaign_id = ? AND status = 'approved' AND active = 1 AND expires_at IS NOT NULL AND expires_at <= ?").run(record.campaignId, record.issuedAt);
      const replay = this.#database.prepare(`
        SELECT approvals.* FROM approval_issuance_keys
        JOIN approvals ON approvals.id = approval_issuance_keys.approval_id
        WHERE approval_issuance_keys.campaign_id = ? AND approval_issuance_keys.idempotency_key = ?
      `).get(record.campaignId, record.idempotencyKey) as ApprovalRow | undefined;
      if (replay !== undefined) {
        if (replay.proposal_id !== record.proposalId || replay.action_digest !== record.actionDigest || replay.expected_campaign_version !== record.expectedVersion) throw new ApprovalIssuanceConflict();
        return mapApproval(replay);
      }
      const proposal = currentApprovalProposal(this.#snapshot(row));
      if (proposal === null || proposal.proposalId !== record.proposalId || proposal.actionDigest !== record.actionDigest || proposal.expectedCampaignVersion !== record.expectedVersion) throw new ApprovalIssuanceConflict();
      const approval = issueDomainApproval({
        id: record.approvalId, campaignId: record.campaignId, action: proposal.payload.action, actionDigest: proposal.actionDigest,
        issuedAt: record.issuedAt, expiresAt: record.expiresAt, proposalId: proposal.proposalId,
        expectedCampaignVersion: proposal.expectedCampaignVersion, expectedCampaignStatus: proposal.expectedCampaignStatus,
        expectedCurrentCommitSha: proposal.expectedCurrentCommitSha ?? null, payload: structuredClone(proposal.payload),
        trustedProposalAuthority: true, active: true,
      });
      this.#database.prepare(`UPDATE approvals SET active = 0 WHERE campaign_id = ? AND status = 'approved' AND active = 1 AND
        (proposal_id IS NULL OR proposal_id <> ? OR expected_campaign_version <> ? OR trusted_proposal_authority <> 1)`)
        .run(record.campaignId, proposal.proposalId, proposal.expectedCampaignVersion);
      const existing = this.#database.prepare("SELECT id FROM approvals WHERE campaign_id = ? AND action_digest = ? AND status = 'approved' AND active = 1").get(record.campaignId, approval.actionDigest) as { id: string } | undefined;
      if (existing !== undefined) throw new ApprovalIssuanceConflict();
      this.#insertApproval(approval);
      this.#database.prepare("INSERT INTO approval_issuance_keys (campaign_id, idempotency_key, approval_id) VALUES (?, ?, ?)").run(record.campaignId, record.idempotencyKey, approval.id);
      return approval;
    });
    try { return issue.immediate(); } catch (error) {
      if (error instanceof ApprovalIssuanceConflict) throw error;
      if (typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT")) throw new ApprovalIssuanceConflict();
      throw error;
    }
  }

  /** @deprecated Test/port compatibility only; production orchestration must claim atomically. */
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
        SET status = 'consumed', consumed_at = ?, active = 0
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
    let parsedFinding: QodoFinding;
    try { parsedFinding = parseQodoFinding(finding); } catch { throw new TypeError("Invalid Qodo finding"); }
    this.#upsertQodoFinding(campaignId, iteration, parsedFinding);
  }

  async applyQodoReview(campaignId: string, record: QodoReviewClaimRecord): Promise<void> {
    assertCampaignQodoIteration(record.campaign.qodoIteration);
    if (record.campaign.id !== campaignId || record.campaign.version !== record.expectedVersion + 1 ||
      !Number.isInteger(record.reviewIteration) || record.reviewIteration < 0 || record.reviewIteration > 3) {
      throw new CampaignVersionConflict(campaignId, record.expectedVersion);
    }
    const eventRecords = [record.claimedEvent, ...record.findings.map(({ event }) => event), record.outcomeEvent];
    if (record.claimedEvent.eventType !== "qodo_review_claimed" || !validQodoOutcome(record.campaign.status, record.outcomeEvent.eventType) ||
      record.findings.some(({ event }) => event.eventType !== "qodo_finding_recorded") ||
      new Set(eventRecords.map(({ id }) => id)).size !== eventRecords.length) throw new Error("Invalid atomic Qodo review events");
    const occurredAt = eventRecords.map((event) => normalizeTimestamp(event.occurredAt, "event occurredAt"));
    const parsedFindings = record.findings.map(({ iteration, finding, event }) => {
      assertQodoFindingIteration(iteration);
      return { iteration, finding: parseQodoFinding(finding), event };
    });
    const write = this.#database.transaction(() => {
      record.persistenceLease?.assertCurrent();
      this.#assertClaim(campaignId, record.expectedVersion, "qodo_review");
      this.#assertNoBlockingExternalAction(campaignId);
      const existing = this.#database.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as CampaignRow | undefined;
      if (existing === undefined || existing.qodo_iteration !== record.reviewIteration ||
        existing.repository !== record.campaign.repository || existing.issue_number !== record.campaign.issueNumber ||
        existing.issue_url !== record.campaign.issueUrl || existing.parent_session_id !== record.campaign.parentSessionId ||
        this.#currentCommit(campaignId) !== record.expectedCommitSha || this.#currentPullRequest(campaignId) !== record.expectedPullRequest) {
        throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      }
      const duplicate = this.#database.prepare(`SELECT id FROM campaign_events WHERE campaign_id = ? AND event_type = 'qodo_review_claimed'
        AND json_extract(payload_json, '$.reviewId') = ? AND json_extract(payload_json, '$.commitSha') = ?
        AND json_extract(payload_json, '$.reviewIteration') = ? LIMIT 1`).get(campaignId, record.reviewId, record.expectedCommitSha, record.reviewIteration);
      if (duplicate !== undefined) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      const updated = this.#database.prepare(`UPDATE campaigns SET lane = ?, status = ?, qodo_iteration = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'qodo_review'`).run(
        record.campaign.lane, record.campaign.status, record.campaign.qodoIteration, occurredAt[0], campaignId, record.expectedVersion,
      );
      if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      this.#insertEvent(campaignId, record.claimedEvent, occurredAt[0] as string);
      for (let index = 0; index < parsedFindings.length; index += 1) {
        const findingRecord = parsedFindings[index];
        if (findingRecord === undefined) throw new Error("Missing Qodo finding record");
        this.#upsertQodoFinding(campaignId, findingRecord.iteration, findingRecord.finding);
        this.#insertEvent(campaignId, findingRecord.event, occurredAt[index + 1] as string);
      }
      this.#insertEvent(campaignId, record.outcomeEvent, occurredAt.at(-1) as string);
    });
    write.immediate();
  }

  async escalateQodoReview(campaignId: string, record: QodoEscalationRecord): Promise<void> {
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (record.event.eventType !== "quality_gate_escalated" || record.campaign.status !== "human_escalation" || record.campaign.version !== record.expectedVersion + 1) {
      throw new Error("Invalid Qodo escalation record");
    }
    const escalate = this.#database.transaction(() => {
      record.persistenceLease?.assertCurrent();
      this.#assertClaim(campaignId, record.expectedVersion, record.expectedStatus);
      const updated = this.#database.prepare("UPDATE campaigns SET status = 'human_escalation', version = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?")
        .run(record.campaign.version, occurredAt, campaignId, record.expectedVersion, record.expectedStatus);
      if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      this.#insertEvent(campaignId, record.event, occurredAt);
    });
    escalate.immediate();
  }

  #upsertQodoFinding(campaignId: string, iteration: number, parsedFinding: QodoFinding): void {
    const result = this.#database.prepare(`
      INSERT INTO qodo_findings (
        id, campaign_id, severity, status, summary, source_url, body, path, line, disposition, iteration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campaign_id, id) DO UPDATE SET
        severity = excluded.severity,
        status = excluded.status,
        summary = excluded.summary,
        source_url = excluded.source_url,
        body = excluded.body,
        path = excluded.path,
        line = excluded.line,
        disposition = excluded.disposition,
        iteration = excluded.iteration
      WHERE excluded.iteration >= qodo_findings.iteration
    `).run(
      parsedFinding.id,
      campaignId,
      parsedFinding.severity,
      parsedFinding.status,
      parsedFinding.summary,
      parsedFinding.sourceUrl ?? null,
      parsedFinding.body ?? null,
      parsedFinding.path ?? null,
      parsedFinding.line ?? null,
      parsedFinding.disposition ?? null,
      iteration,
    );
    if (result.changes !== 1) {
      throw new Error(`Stale Qodo finding iteration for ${parsedFinding.id}`);
    }
  }

  async claimExternalAction(campaignId: string, record: ExternalActionClaimRecord): Promise<ExternalActionClaim> {
    validateExternalActionPayload(record.payload);
    const consumedAt = normalizeTimestamp(record.consumedAt, "approval consumedAt");
    const leaseStartedAt = normalizeTimestamp(record.leaseStartedAt, "external action claim lease");
    const occurredAt = normalizeTimestamp(record.attemptedEvent.occurredAt, "event occurredAt");
    if (leaseStartedAt !== consumedAt || occurredAt !== leaseStartedAt) throw new Error("External action claim lease is not bound to its attempt");
    if (externalActionDigest(record.payload) !== record.actionDigest) throw new Error("External action payload digest does not match claim");
    if (record.attemptedEvent.eventType !== "external_action_attempted") throw new Error("Invalid external action attempted event");
    assertExternalActionEventVersion(record.attemptedEvent.payload, record.expectedVersion, record.expectedVersion);
    const claim = this.#database.transaction((): { readonly rejected: true } | { readonly retired: true } | { readonly claim: ExternalActionClaim } => {
      this.#assertClaim(campaignId, record.expectedVersion, record.expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      const currentCommitSha = this.#currentCommit(campaignId);
      if (currentCommitSha !== record.expectedCurrentCommitSha) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
      if (record.payload.action === "push_branch" && currentCommitSha === undefined) throw new Error("Branch push requires a current campaign head");
      if ((record.payload.action === "create_pr" || record.payload.action === "update_pr") && record.payload.commitSha !== currentCommitSha) throw new Error("External action commit does not match current campaign head");
      const repairVerificationReceipt = record.payload.action === "update_pr" ? this.#assertUpdatePullRequestIdentity(campaignId, record.payload) : undefined;

      const approvalRow = this.#database.prepare("SELECT * FROM approvals WHERE id = ? AND active = 1 AND trusted_proposal_authority = 1").get(record.approvalId) as ApprovalRow | undefined;
      const approved = approvalRow === undefined ? undefined : mapApproval(approvalRow);
      if (approved?.expiresAt !== undefined && Date.parse(approved.expiresAt) <= Date.parse(consumedAt)) {
        this.#database.prepare("UPDATE approvals SET active = 0 WHERE id = ? AND campaign_id = ? AND status = 'approved'").run(record.approvalId, campaignId);
        return { retired: true };
      }
      if (approved !== undefined) {
        const campaignRow = this.#database.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId) as CampaignRow | undefined;
        const proposal = campaignRow === undefined ? null : currentApprovalProposal(this.#snapshot(campaignRow));
        if (!approvalMatchesProposal(approved, proposal)) {
          this.#database.prepare("UPDATE approvals SET status = 'rejected', active = 0 WHERE id = ? AND campaign_id = ? AND status = 'approved'").run(record.approvalId, campaignId);
          return { rejected: true };
        }
      }
      if (approved === undefined || approved.campaignId !== campaignId || approved.payload === undefined || approved.proposalId === undefined ||
        approved.expectedCampaignVersion !== record.expectedVersion || approved.expectedCampaignStatus !== record.expectedStatus ||
        approved.expectedCurrentCommitSha !== (currentCommitSha ?? null) || approved.actionDigest !== record.actionDigest ||
        canonicalExternalActionJson(approved.payload as ExternalActionPayload) !== canonicalExternalActionJson(record.payload)) {
        throw new Error("External action does not match the approved proposal authority");
      }
      validateExternalActionPayload(approved.payload as ExternalActionPayload);
      if (!isApprovalActionAllowed(approved.action, approved.expectedCampaignStatus)) throw new Error("Campaign state does not allow this approval action");
      consumeDomainApproval(approved, approved.actionDigest, consumedAt);
      const consumed = this.#database.prepare(`
        UPDATE approvals SET status = 'consumed', consumed_at = ?, active = 0
        WHERE id = ? AND campaign_id = ? AND action_digest = ? AND status = 'approved'
          AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      `).run(consumedAt, record.approvalId, campaignId, record.actionDigest, consumedAt);
      if (consumed.changes !== 1) throw new Error("Approval is not available");

      this.#database.prepare(`
        INSERT INTO external_action_claims (
          id, campaign_id, approval_id, action_digest, payload_json, current_commit_sha,
          claimed_campaign_version, claimed_campaign_status, status, attempted_at, lease_started_at, repair_verification_receipt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        record.claimId, campaignId, record.approvalId, approved.actionDigest,
        canonicalExternalActionJson(approved.payload as ExternalActionPayload), currentCommitSha ?? null,
        approved.expectedCampaignVersion, approved.expectedCampaignStatus, consumedAt, leaseStartedAt, repairVerificationReceipt ?? null,
      );
      this.#insertEvent(campaignId, record.attemptedEvent, occurredAt);
      return { claim: this.#requiredExternalActionClaim(campaignId, record.claimId, "active") };
    });
    const result = claim.immediate();
    if ("rejected" in result) throw new Error("External action does not match the current approved proposal authority");
    if ("retired" in result) throw new Error("Approval is not available because it expired");
    return result.claim;
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
      const returnsToReview = payload.action === "update_pr";
      const opensPullRequest = payload.action === "create_pr" && record.publishedReference?.kind === "pull_request";
      const resultingVersion = claim.claimedCampaignVersion + (changed || returnsToReview || opensPullRequest ? 1 : 0);
      assertExternalActionEventVersion(record.completedEvent.payload, claim.claimedCampaignVersion, resultingVersion);
      if (record.nextProposalEvent !== undefined) {
        if (record.nextProposalEvent.id === record.completedEvent.id) throw new Error("Follow-up proposal event must have a distinct id");
        if (claim.payload.action !== "push_branch" || record.newCommitSha === undefined) throw new Error("Follow-up proposal requires a completed branch push");
        assertProposalEvent(record.nextProposalEvent, resultingVersion, claim.claimedCampaignStatus, claim.payload.repository, claim.payload.issueNumber, record.newCommitSha, "create_pr", claim.payload.branch);
      }
      if (changed) {
        this.#replaceCommit(campaignId, record.newCommitSha);
      }
      if (record.publishedReference !== undefined) this.#recordPublishedReference(campaignId, payload, record.publishedReference);
      if (changed || returnsToReview || opensPullRequest) {
        const nextStatus = returnsToReview ? "qodo_review" : opensPullRequest ? "pull_request_open" : claim.claimedCampaignStatus;
        const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, status = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(nextStatus, completedAt, campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
        if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, claim.claimedCampaignVersion);
      }
      this.#insertEvent(campaignId, record.completedEvent, occurredAt);
      if (record.nextProposalEvent !== undefined) this.#insertEvent(campaignId, record.nextProposalEvent, normalizeTimestamp(record.nextProposalEvent.occurredAt, "proposal event occurredAt"));
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
      this.#insertEvent(campaignId, record.event, occurredAt);
      const changed = this.#database.prepare("UPDATE external_action_claims SET status = 'outcome_unknown' WHERE id = ? AND campaign_id = ? AND status = 'active'").run(record.claimId, campaignId);
      if (changed.changes !== 1) throw new Error(`External action claim ${record.claimId} is stale`);
    });
    mark.immediate();
  }

  async recoverStaleExternalActionClaim(campaignId: string, record: ExternalActionStaleRecoveryRecord): Promise<void> {
    const staleBefore = normalizeTimestamp(record.staleBefore, "stale claim threshold");
    const recoveredAt = normalizeTimestamp(record.recoveredAt, "stale claim recovery");
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (recoveredAt !== occurredAt) throw new Error("Stale claim recovery event timestamp does not match recovery");
    if (record.operatorDisposition.trim().length === 0) throw new Error("Stale claim recovery disposition is required");
    if (record.event.eventType !== "external_action_stale_recovered") throw new Error("Invalid stale external action recovery event");
    const recover = this.#database.transaction(() => {
      const claim = this.#requiredExternalActionClaim(campaignId, record.claimId, "active");
      assertStaleRecoveryEvent(record.event, claim);
      this.#assertClaim(campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
      if (this.#currentCommit(campaignId) !== claim.currentCommitSha) throw new Error("External action current head changed after claim");
      if (Date.parse(claim.leaseStartedAt) > Date.parse(staleBefore)) throw new Error("External action claim is not stale");
      this.#insertEvent(campaignId, record.event, occurredAt);
      const changed = this.#database.prepare("UPDATE external_action_claims SET status = 'outcome_unknown' WHERE id = ? AND campaign_id = ? AND status = 'active' AND lease_started_at <= ?").run(record.claimId, campaignId, staleBefore);
      if (changed.changes !== 1) throw new Error(`External action claim ${record.claimId} is not stale or active`);
    });
    recover.immediate();
  }

  async reconcileExternalAction(campaignId: string, record: ExternalActionReconciliationRecord): Promise<number> {
    const reconciledAt = normalizeTimestamp(record.reconciledAt, "external action reconciliation");
    const occurredAt = normalizeTimestamp(record.event.occurredAt, "event occurredAt");
    if (record.observedCanonicalHead !== undefined) assertCommitSha(record.observedCanonicalHead);
    if (record.event.eventType !== "external_action_reconciled") throw new Error("Invalid external action reconciliation event");
    const reconcile = this.#database.transaction(() => {
      const claim = this.#requiredExternalActionClaim(campaignId, record.claimId, "outcome_unknown");
      const campaign = this.#database.prepare("SELECT version, status FROM campaigns WHERE id = ?").get(campaignId) as Pick<CampaignRow, "version" | "status"> | undefined;
      if (campaign === undefined) throw new Error(`Campaign ${campaignId} does not exist`);
      const current = this.#currentCommit(campaignId);
      const preserveVerifiedRepair = record.disposition === "confirmed_not_completed" && claim.payload.action === "update_pr";
      const changed = !preserveVerifiedRepair && record.observedCanonicalHead !== undefined && record.observedCanonicalHead !== current;
      const confirmedUpdate = record.disposition === "confirmed_completed" && claim.payload.action === "update_pr";
      const confirmedCreate = record.disposition === "confirmed_completed" && claim.payload.action === "create_pr";
      if (confirmedUpdate && (record.observedCanonicalHead !== claim.payload.commitSha || current !== claim.payload.commitSha || campaign.status !== "repair" || this.#currentPullRequest(campaignId) !== claim.payload.pullRequest)) {
        throw new Error("Confirmed update_pr reconciliation does not match current authority");
      }
      if (confirmedCreate && (record.observedPullRequest === undefined || !isPullRequest(record.observedPullRequest, claim.payload.repository) || current !== claim.payload.commitSha || campaign.status !== "contribution_approval")) {
        throw new Error("Confirmed create_pr reconciliation does not match current authority");
      }
      const resultingVersion = campaign.version + (changed || confirmedUpdate || confirmedCreate ? 1 : 0);
      assertExternalActionEventVersion(record.event.payload, campaign.version, resultingVersion);
      if (changed) {
        this.#replaceCommit(campaignId, record.observedCanonicalHead);
      }
      if (record.disposition === "confirmed_completed" && claim.payload.action === "push_branch") this.#recordPublishedReference(campaignId, claim.payload, { kind: "branch", value: claim.payload.branch });
      if (confirmedCreate && record.observedPullRequest !== undefined) this.#recordPublishedReference(campaignId, claim.payload, { kind: "pull_request", value: record.observedPullRequest });
      if (changed || confirmedUpdate || confirmedCreate) {
        const nextStatus = confirmedUpdate ? "qodo_review" : confirmedCreate ? "pull_request_open" : campaign.status;
        const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, status = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(nextStatus, reconciledAt, campaignId, campaign.version, campaign.status);
        if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, campaign.version);
      }
      this.#insertEvent(campaignId, record.event, occurredAt);
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
      record.persistenceLease?.assertCurrent();
      this.#assertClaim(campaignId, record.expectedVersion, record.expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      let resultingVersion = record.expectedVersion;
      const currentBefore = this.#currentCommit(campaignId);
      if (record.newCommitSha !== undefined && currentBefore !== record.newCommitSha) resultingVersion += 1;
      assertChildEventVersion(record.event.payload, record.expectedVersion, resultingVersion);
      if (record.nextCampaign !== undefined || record.nextProposalEvent !== undefined) {
        if (record.nextCampaign === undefined || record.nextProposalEvent === undefined) throw new Error("Next campaign and proposal must be persisted together");
        if (record.newCommitSha !== undefined || record.expectedStatus !== "verification" || record.event.eventType !== "campaign_operation_completed" || record.operationResult?.operation !== "verify") throw new Error("Contribution approval requires a completed verification without a new commit");
        if (record.nextCampaign.version !== resultingVersion + 1 || record.nextCampaign.status !== "contribution_approval") throw new Error("Invalid contribution approval campaign transition");
        if (record.nextCampaign.id !== campaignId || record.nextCampaign.repository !== this.#repository(campaignId) || record.nextCampaign.issueNumber !== this.#issueNumber(campaignId) || record.nextCampaign.issueUrl !== this.#issueUrl(campaignId) || record.nextCampaign.parentSessionId !== this.#parentSession(campaignId) || record.nextCampaign.lane !== this.#lane(campaignId) || record.nextCampaign.qodoIteration !== this.#qodoIteration(campaignId)) throw new Error("Contribution approval campaign identity changed");
        assertProposalEvent(record.nextProposalEvent, record.nextCampaign.version, record.nextCampaign.status, record.nextCampaign.repository, record.nextCampaign.issueNumber, currentBefore, "push_branch");
      }
      if (record.newCommitSha !== undefined) {
        const current = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'commit'").get(campaignId) as { value: string } | undefined;
        if (current?.value !== record.newCommitSha) {
          this.#replaceCommit(campaignId, record.newCommitSha);
          const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(new Date().toISOString(), campaignId, record.expectedVersion, record.expectedStatus);
          if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
        }
      }
      this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'child_session', ?) ON CONFLICT DO NOTHING").run(campaignId, record.childSessionId);
      this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'sandbox', ?) ON CONFLICT DO NOTHING").run(campaignId, record.sandboxSessionId ?? record.childSessionId);
      if (record.event.eventType === "campaign_operation_completed") {
        const result = record.operationResult;
        if (result === undefined || result.currentCommitSha !== this.#currentCommit(campaignId)) throw new Error("Completed child result lacks typed operation authority");
        const campaign = this.#database.prepare("SELECT qodo_iteration FROM campaigns WHERE id = ?").get(campaignId) as { qodo_iteration: number };
        if (result.qodoIteration !== campaign.qodo_iteration) throw new Error("Operation result Qodo iteration does not match campaign");
        if (result.operation === "repair" && (result.pullRequest === undefined || !isPullRequest(result.pullRequest, this.#repository(campaignId)) || this.#currentPullRequest(campaignId) !== result.pullRequest || !validRepairAuthority(result.repairVerification, campaignId, this.#repository(campaignId), result.pullRequest, record.childSessionId, record.sandboxSessionId, result.currentCommitSha))) throw new Error("Repair result lacks exact verified publication authority");
      } else if (record.operationResult !== undefined) {
        throw new Error("Typed operation authority requires a completed child event");
      }
      this.#insertEvent(campaignId, record.event, occurredAt);
      if (record.operationResult !== undefined) {
        const result = record.operationResult;
        this.#database.prepare(`INSERT INTO campaign_operation_results
          (event_id, campaign_id, operation, resulting_campaign_version, current_commit_sha, pull_request, qodo_iteration, child_session_id, repair_verification_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(record.event.id, campaignId, result.operation, resultingVersion, result.currentCommitSha, result.pullRequest ?? null, result.qodoIteration, record.childSessionId,
          result.repairVerification === undefined ? null : JSON.stringify(result.repairVerification));
      }
      if (record.nextCampaign !== undefined) {
        const updated = this.#database.prepare("UPDATE campaigns SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(record.nextCampaign.status, record.nextCampaign.version, new Date().toISOString(), campaignId, resultingVersion, record.expectedStatus);
        if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, resultingVersion);
      }
      if (record.nextProposalEvent !== undefined) this.#insertEvent(campaignId, record.nextProposalEvent, normalizeTimestamp(record.nextProposalEvent.occurredAt, "proposal event occurredAt"));
      return record.nextCampaign?.version ?? resultingVersion;
    });
    return write.immediate();
  }

  async setExternalReference(campaignId: string, reference: ExternalReference): Promise<void> {
    if (reference.kind === "commit") throw new Error("Current commit requires a versioned replacement");
    if (reference.kind === "pull_request") throw new Error("Current pull request requires a versioned replacement");
    const write = this.#database.transaction(() => {
      this.#database.prepare(`
        INSERT INTO external_references (campaign_id, kind, value)
        VALUES (?, ?, ?)
        ON CONFLICT(campaign_id, kind, value) DO NOTHING
      `).run(campaignId, reference.kind, reference.value);
    });
    write.immediate();
  }

  async replaceCurrentPullRequest(
    campaignId: string,
    pullRequest: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number> {
    if (!statusesAllowingIndependentPullRequestReplacement.has(expectedStatus)) {
      throw new Error(`Campaign status ${expectedStatus} does not allow independent current pull request replacement`);
    }
    const replace = this.#database.transaction(() => {
      const campaign = this.#database.prepare("SELECT repository FROM campaigns WHERE id = ?").get(campaignId) as Pick<CampaignRow, "repository"> | undefined;
      if (campaign === undefined || !isPullRequest(pullRequest, campaign.repository)) throw new Error("Invalid current pull request");
      this.#assertClaim(campaignId, expectedVersion, expectedStatus);
      this.#assertNoBlockingExternalAction(campaignId);
      const current = this.#currentPullRequest(campaignId);
      if (current === pullRequest) return expectedVersion;
      this.#replacePullRequest(campaignId, pullRequest);
      const updated = this.#database.prepare("UPDATE campaigns SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = ?").run(new Date().toISOString(), campaignId, expectedVersion, expectedStatus);
      if (updated.changes !== 1) throw new CampaignVersionConflict(campaignId, expectedVersion);
      return expectedVersion + 1;
    });
    return replace.immediate();
  }

  #recordPublishedReference(campaignId: string, payload: ExternalActionPayload, reference: ExternalReference): void {
    if (payload.action === "push_branch" && reference.kind === "branch" && reference.value === payload.branch) {
      this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'branch', ?) ON CONFLICT DO NOTHING").run(campaignId, reference.value);
      return;
    }
    if (payload.action === "create_pr" && reference.kind === "pull_request" && isPullRequest(reference.value, payload.repository)) {
      const current = this.#currentPullRequest(campaignId);
      if (current !== undefined && current !== reference.value) throw new Error("Campaign already has a different pull request");
      if (current === undefined) this.#replacePullRequest(campaignId, reference.value);
      return;
    }
    throw new Error("Published reference does not match the claimed external action");
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

  #currentPullRequest(campaignId: string): string | undefined {
    const pullRequests = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'pull_request'").all(campaignId) as { value: string }[];
    if (pullRequests.length > 1) throw new Error("Campaign current pull request is ambiguous");
    return pullRequests[0]?.value;
  }

  #assertUpdatePullRequestIdentity(
    campaignId: string,
    payload: Extract<ExternalActionPayload, { action: "update_pr" }>,
  ): string {
    const campaign = this.#database.prepare("SELECT repository, version, qodo_iteration FROM campaigns WHERE id = ?").get(campaignId) as Pick<CampaignRow, "repository" | "version" | "qodo_iteration"> | undefined;
    if (campaign === undefined) throw new Error("Campaign does not exist");
    const pullRequests = this.#database.prepare("SELECT value FROM external_references WHERE campaign_id = ? AND kind = 'pull_request'").all(campaignId) as { value: string }[];
    if (pullRequests.length !== 1 || pullRequests[0]?.value !== payload.pullRequest || !isPullRequest(payload.pullRequest, campaign.repository)) {
      throw new Error("External action pull request does not match campaign memory");
    }
    const matches = this.#database.prepare(`
      SELECT event_id, child_session_id, repair_verification_json FROM campaign_operation_results
      WHERE campaign_id = ? AND operation = 'repair'
        AND resulting_campaign_version = ? AND current_commit_sha = ?
        AND pull_request = ? AND qodo_iteration = ?
    `).all(campaignId, campaign.version, payload.commitSha, payload.pullRequest, campaign.qodo_iteration) as { event_id: string; child_session_id: string; repair_verification_json: string | null }[];
    const match = matches[0];
    if (matches.length !== 1 || match?.repair_verification_json === null || match === undefined) throw new Error("Campaign lacks one unambiguous verified repair completion event for this update");
    let authority: unknown;
    try { authority = JSON.parse(match.repair_verification_json); } catch { throw new Error("Campaign repair verification receipt is invalid"); }
    if (!validStoredRepairAuthority(authority, campaignId, campaign.repository, payload.pullRequest, match.child_session_id, payload.commitSha)) throw new Error("Campaign repair verification receipt does not match this update");
    return (authority as { receipt: string }).receipt;
  }

  #repository(campaignId: string): string {
    const row = this.#database.prepare("SELECT repository FROM campaigns WHERE id = ?").get(campaignId) as { repository: string } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.repository;
  }

  #issueNumber(campaignId: string): number {
    const row = this.#database.prepare("SELECT issue_number FROM campaigns WHERE id = ?").get(campaignId) as { issue_number: number } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.issue_number;
  }

  #issueUrl(campaignId: string): string {
    const row = this.#database.prepare("SELECT issue_url FROM campaigns WHERE id = ?").get(campaignId) as { issue_url: string } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.issue_url;
  }

  #parentSession(campaignId: string): string {
    const row = this.#database.prepare("SELECT parent_session_id FROM campaigns WHERE id = ?").get(campaignId) as { parent_session_id: string } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.parent_session_id;
  }

  #lane(campaignId: string): Campaign["lane"] {
    const row = this.#database.prepare("SELECT lane FROM campaigns WHERE id = ?").get(campaignId) as { lane: Campaign["lane"] } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.lane;
  }

  #qodoIteration(campaignId: string): number {
    const row = this.#database.prepare("SELECT qodo_iteration FROM campaigns WHERE id = ?").get(campaignId) as { qodo_iteration: number } | undefined;
    if (row === undefined) throw new Error("Campaign does not exist");
    return row.qodo_iteration;
  }

  #insertApproval(approval: Approval): void {
    const issuedAt = normalizeTimestamp(approval.issuedAt, "approval issuedAt");
    const expiresAt = approval.expiresAt === undefined ? null : normalizeTimestamp(approval.expiresAt, "approval expiry");
    const consumedAt = approval.consumedAt === undefined ? null : normalizeTimestamp(approval.consumedAt, "approval consumedAt");
    const payloadJson = approval.payload === undefined ? null : canonicalExternalActionJson(approval.payload as ExternalActionPayload);
    this.#database.prepare(`INSERT INTO approvals (
      id, campaign_id, action, action_digest, status, issued_at, expires_at, consumed_at, active,
      proposal_id, expected_campaign_version, expected_campaign_status, expected_current_commit_sha, payload_json,
      trusted_proposal_authority
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(approval.id, approval.campaignId, approval.action, approval.actionDigest, approval.status, issuedAt, expiresAt, consumedAt,
        approval.status === "approved" && approval.active === true && approval.trustedProposalAuthority === true ? 1 : 0,
        approval.proposalId ?? null, approval.expectedCampaignVersion ?? null,
        approval.expectedCampaignStatus ?? null, approval.expectedCurrentCommitSha ?? null, payloadJson,
        approval.trustedProposalAuthority === true ? 1 : 0);
  }

  #insertEvent(campaignId: string, event: CampaignEventInput, occurredAt: string): void {
    const next = this.#database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM campaign_events WHERE campaign_id = ?").get(campaignId) as { next: number };
    this.#database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at, sequence) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, campaignId, event.eventType, JSON.stringify(event.payload), occurredAt, next.next);
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

  #replacePullRequest(campaignId: string, pullRequest: string): void {
    this.#database.prepare("DELETE FROM external_references WHERE campaign_id = ? AND kind = 'pull_request'").run(campaignId);
    this.#database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run(campaignId, pullRequest);
  }

  #snapshot(row: CampaignRow): CampaignSnapshot {
    const evidence = this.#database.prepare(`
      SELECT id, source_url, retrieved_at, observation, kind
      FROM campaign_evidence WHERE campaign_id = ? ORDER BY retrieved_at, id
    `).all(row.id) as EvidenceRow[];
    const events = this.#database.prepare(`
      SELECT id, event_type, payload_json, occurred_at, sequence
      FROM campaign_events
      WHERE campaign_id = ?
      ORDER BY sequence
    `).all(row.id) as EventRow[];
    const approvals = this.#database.prepare(`
      SELECT * FROM approvals WHERE campaign_id = ? ORDER BY issued_at, id
    `).all(row.id) as ApprovalRow[];
    const qodoFindings = this.#database.prepare(`
      SELECT id, severity, status, summary, source_url, body, path, line, disposition
      FROM qodo_findings WHERE campaign_id = ? ORDER BY iteration, id
    `).all(row.id) as QodoFindingRow[];
    const externalReferences = this.#database.prepare(`
      SELECT kind, value FROM external_references
      WHERE campaign_id = ? ORDER BY kind, value
    `).all(row.id) as ExternalReferenceRow[];
    const externalActionClaims = this.#database.prepare(`
      SELECT * FROM external_action_claims WHERE campaign_id = ? ORDER BY attempted_at, id
    `).all(row.id) as ExternalActionClaimRow[];
    const mappedEvents = events.map(mapEvent);
    assertValidStoredEventSequence(mappedEvents);

    return {
      campaign: mapCampaign(row),
      evidence: evidence.map(mapEvidence),
      events: mappedEvents,
      approvals: approvals.map(mapApproval),
      qodoFindings: qodoFindings.map(mapQodoFinding),
      externalReferences,
      externalActionClaims: externalActionClaims.map(mapExternalActionClaim),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
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
  if (!Number.isSafeInteger(row.sequence) || (row.sequence ?? 0) < 1) throw new Error(`Invalid sequence for campaign event ${row.id}`);
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new Error(`Invalid payload JSON for campaign event ${row.id}`, { cause: error });
  }
  return { id: row.id, eventType: row.event_type, payload, occurredAt: row.occurred_at, sequence: row.sequence as number };
}

function assertValidStoredEventSequence(events: readonly CampaignEvent[]): void {
  const seen = new Set<number>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || seen.has(event.sequence)) throw new Error("Campaign event sequence is invalid");
    seen.add(event.sequence);
  }
}

function assertProposalEvent(
  event: CampaignEventInput,
  expectedVersion: number,
  expectedStatus: CampaignStatus,
  repository: string,
  issueNumber: number,
  expectedCommitSha: string | undefined,
  expectedAction: "push_branch" | "create_pr",
  expectedBranch?: string,
): void {
  if (event.eventType !== "external_action_proposed" || !isRecord(event.payload)) throw new Error("Invalid external action proposal event");
  const payload = event.payload;
  const proposalKeys = ["proposalId", "payload", "actionDigest", "expectedCampaignVersion", "expectedCampaignStatus", "expectedCurrentCommitSha", "brief"];
  if (Object.keys(payload).length !== proposalKeys.length || Object.keys(payload).some((key) => !proposalKeys.includes(key)) || payload.proposalId !== event.id || payload.expectedCampaignVersion !== expectedVersion || payload.expectedCampaignStatus !== expectedStatus || payload.expectedCurrentCommitSha !== expectedCommitSha) throw new Error("External action proposal is not bound to the campaign version");
  if (!isRecord(payload.payload)) throw new Error("External action proposal payload is invalid");
  const action = payload.payload as ExternalActionPayload;
  validateExternalActionPayload(action);
  if (action.action !== expectedAction || action.repository !== repository || action.issueNumber !== issueNumber || externalActionDigest(action) !== payload.actionDigest) throw new Error("External action proposal identity is invalid");
  if (expectedCommitSha === undefined || action.commitSha !== expectedCommitSha) throw new Error("External action proposal commit is not current");
  if (expectedBranch !== undefined && (action.action !== "create_pr" || action.branch !== expectedBranch)) throw new Error("Follow-up proposal branch does not match push");
  if (!isRecord(payload.brief)) throw new Error("External action proposal brief is invalid");
  const brief = payload.brief;
  const briefKeys = ["policy", "approach", "files", "risks", "tests", "safetyResult", "qodoStatus", "aiDisclosure"];
  if (Object.keys(brief).length !== briefKeys.length || Object.keys(brief).some((key) => !briefKeys.includes(key))) throw new Error("External action proposal brief is invalid");
  for (const key of ["policy", "approach", "safetyResult", "qodoStatus", "aiDisclosure"]) if (typeof brief[key] !== "string" || brief[key].trim().length < 3 || brief[key].length > 20_000) throw new Error("External action proposal brief is invalid");
  for (const key of ["files", "risks", "tests"]) if (!Array.isArray(brief[key]) || brief[key].length === 0 || brief[key].length > 200 || !brief[key].every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 20_000)) throw new Error("External action proposal brief is invalid");
}

function mapApproval(row: ApprovalRow): Approval {
  let payload: unknown;
  if (row.payload_json !== null) {
    try { payload = JSON.parse(row.payload_json) as unknown; } catch { throw new Error("Invalid stored approval payload"); }
    validateExternalActionPayload(payload as ExternalActionPayload);
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    action: row.action,
    actionDigest: row.action_digest,
    status: row.status,
    issuedAt: row.issued_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.proposal_id === null ? {} : { proposalId: row.proposal_id }),
    ...(row.expected_campaign_version === null ? {} : { expectedCampaignVersion: row.expected_campaign_version }),
    ...(row.expected_campaign_status === null ? {} : { expectedCampaignStatus: row.expected_campaign_status }),
    ...(row.proposal_id === null ? {} : { expectedCurrentCommitSha: row.expected_current_commit_sha }),
    ...(payload === undefined ? {} : { payload }),
    active: row.active === 1,
    trustedProposalAuthority: row.trusted_proposal_authority === 1,
  };
}

function approvalMatchesProposal(approval: Approval, proposal: ReturnType<typeof currentApprovalProposal>): boolean {
  if (proposal === null || approval.payload === undefined) return false;
  return approval.proposalId === proposal.proposalId &&
    approval.action === proposal.payload.action &&
    approval.actionDigest === proposal.actionDigest &&
    approval.expectedCampaignVersion === proposal.expectedCampaignVersion &&
    approval.expectedCampaignStatus === proposal.expectedCampaignStatus &&
    approval.expectedCurrentCommitSha === (proposal.expectedCurrentCommitSha ?? null) &&
    canonicalExternalActionJson(approval.payload as ExternalActionPayload) === canonicalExternalActionJson(proposal.payload);
}

function mapQodoFinding(row: QodoFindingRow): QodoFinding {
  return {
    id: row.id,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    ...(row.source_url === null ? {} : { sourceUrl: row.source_url }),
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.path === null ? {} : { path: row.path }),
    ...(row.line === null ? {} : { line: row.line }),
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
    leaseStartedAt: row.lease_started_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    ...(row.disposition === null ? {} : { disposition: row.disposition }),
    ...(row.observed_canonical_head === null ? {} : { observedCanonicalHead: row.observed_canonical_head }),
    ...(row.repair_verification_receipt === null ? {} : { repairVerificationReceipt: row.repair_verification_receipt }),
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

function validRepairAuthority(
  value: import("../../application/ports/campaign-store.js").RepairVerificationAuthority | undefined,
  campaignId: string,
  repository: string,
  pullRequest: string,
  childSessionId: string,
  sandboxSessionId: string | undefined,
  commitSha: string,
): boolean {
  return value !== undefined && (value as unknown as Record<string, unknown>).testsPassed === true && value.receipt === value.receipt.trim() && value.receipt.length >= 16 && value.receipt.length <= 512 && value.campaignId === campaignId &&
    value.repository === repository && value.pullRequest === pullRequest && value.childSessionId === childSessionId &&
    value.sandboxSessionId === sandboxSessionId && value.candidateCommitSha === commitSha &&
    value.expectedParentCommitSha !== commitSha && value.testPolicy === "openquest-repair-tests-v1" &&
    value.commands.length > 0 && value.commands.length <= 100 && value.commands.every((command) => typeof command === "string" && command.trim().length > 0 && command.length <= 2_000) &&
    value.evidence.length > 0 && value.evidence.length <= 100 && value.evidence.every((evidence) => (evidence as unknown as Record<string, unknown>).kind === "direct" && typeof evidence.sourceUrl === "string" && evidence.sourceUrl.length <= 2_048 && typeof evidence.observation === "string" && evidence.observation.trim().length > 0 && evidence.observation.length <= 2_000);
}

function validStoredRepairAuthority(value: unknown, campaignId: string, repository: string, pullRequest: string, childSessionId: string, commitSha: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = ["receipt", "campaignId", "repository", "pullRequest", "childSessionId", "sandboxSessionId", "expectedParentCommitSha", "candidateCommitSha", "testPolicy", "testsPassed", "commands", "evidence"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) return false;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.evidence) || !(raw.evidence as unknown[]).every(isDirectEvidenceRecord)) return false;
  const authority = value as Partial<import("../../application/ports/campaign-store.js").RepairVerificationAuthority>;
  return typeof authority.receipt === "string" && typeof authority.sandboxSessionId === "string" && typeof authority.expectedParentCommitSha === "string" &&
    typeof authority.testPolicy === "string" && authority.testsPassed === true && Array.isArray(authority.commands) && Array.isArray(authority.evidence) &&
    validRepairAuthority(authority as import("../../application/ports/campaign-store.js").RepairVerificationAuthority,
      campaignId, repository, pullRequest, childSessionId, authority.sandboxSessionId, commitSha);
}

function isDirectEvidenceRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && record.kind === "direct" && typeof record.sourceUrl === "string" && typeof record.observation === "string";
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

function assertStaleRecoveryEvent(event: CampaignEventInput, claim: ExternalActionClaim): void {
  const payload = event.payload;
  const allowedKeys = new Set([
    "claimId", "action", "actionDigest", "claimedCampaignVersion", "resultingCampaignVersion",
    "claimedCampaignStatus", "disposition", "reason",
  ]);
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    Object.keys(payload).some((key) => !allowedKeys.has(key)) || Object.keys(payload).length !== allowedKeys.size ||
    !("claimId" in payload) || payload.claimId !== claim.id ||
    !("action" in payload) || payload.action !== claim.payload.action ||
    !("actionDigest" in payload) || payload.actionDigest !== claim.actionDigest ||
    !("claimedCampaignStatus" in payload) || payload.claimedCampaignStatus !== claim.claimedCampaignStatus ||
    !("disposition" in payload) || payload.disposition !== "operator_declared_claim_stale" ||
    !("reason" in payload) || payload.reason !== "operator_recovered_stale_active_claim"
  ) throw new Error("Invalid stale external action recovery evidence");
  assertExternalActionEventVersion(payload, claim.claimedCampaignVersion, claim.claimedCampaignVersion);
}

const statusesAllowingIndependentCommitReplacement = new Set<CampaignStatus>([
  "policy_review", "coordination_pending", "preflight", "quarantined", "baseline", "implementation",
  "verification", "contribution_approval", "pull_request_open", "qodo_review", "human_escalation",
]);

const statusesAllowingIndependentPullRequestReplacement = new Set<CampaignStatus>([
  "contribution_approval", "pull_request_open", "qodo_review", "human_escalation",
]);

function validQodoOutcome(status: CampaignStatus, eventType: string): boolean {
  return (status === "qodo_review" && eventType === "quality_gate_passed") ||
    (status === "repair" && eventType === "quality_gate_repair_requested") ||
    (status === "human_escalation" && eventType === "quality_gate_escalated");
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
