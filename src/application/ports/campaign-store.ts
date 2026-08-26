import type { Approval } from "../../domain/approval.js";
import type { Campaign, CampaignStatus } from "../../domain/campaign.js";
import type { Evidence } from "../../domain/evidence.js";
import type { QodoFinding } from "../../domain/quality-gate.js";
import type { ExternalActionPayload } from "../external-action.js";

export interface CampaignEvent {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface ExternalReference {
  readonly kind:
    | "issue"
    | "branch"
    | "pull_request"
    | "commit"
    | "sandbox"
    | "child_session"
    | "ci_run";
  readonly value: string;
}

export interface CampaignSnapshot {
  readonly campaign: Campaign;
  readonly evidence: readonly Evidence[];
  readonly events: readonly CampaignEvent[];
  readonly approvals: readonly Approval[];
  readonly qodoFindings: readonly QodoFinding[];
  readonly externalReferences: readonly ExternalReference[];
  readonly externalActionClaims: readonly ExternalActionClaim[];
}

export type ExternalActionClaimStatus = "active" | "outcome_unknown" | "completed" | "reconciled";
export type ExternalActionDisposition = "confirmed_completed" | "confirmed_not_completed";

export interface ExternalActionClaim {
  readonly id: string;
  readonly campaignId: string;
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly payload: ExternalActionPayload;
  readonly currentCommitSha?: string;
  readonly claimedCampaignVersion: number;
  readonly claimedCampaignStatus: CampaignStatus;
  readonly status: ExternalActionClaimStatus;
  readonly attemptedAt: string;
  readonly leaseStartedAt: string;
  readonly closedAt?: string;
  readonly disposition?: ExternalActionDisposition;
  readonly observedCanonicalHead?: string;
}

export interface ExternalActionClaimRecord {
  readonly claimId: string;
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly payload: ExternalActionPayload;
  readonly expectedCurrentCommitSha?: string;
  readonly expectedVersion: number;
  readonly expectedStatus: CampaignStatus;
  readonly consumedAt: string;
  readonly leaseStartedAt: string;
  readonly attemptedEvent: CampaignEvent;
}

export interface ExternalActionCompletionRecord {
  readonly claimId: string;
  readonly completedAt: string;
  readonly completedEvent: CampaignEvent;
  readonly newCommitSha?: string;
}

export interface ExternalActionOutcomeUnknownRecord {
  readonly claimId: string;
  readonly event: CampaignEvent;
}

export interface ExternalActionStaleRecoveryRecord {
  readonly claimId: string;
  readonly staleBefore: string;
  readonly recoveredAt: string;
  readonly operatorDisposition: string;
  readonly event: CampaignEvent;
}

export interface ExternalActionReconciliationRecord {
  readonly claimId: string;
  readonly disposition: ExternalActionDisposition;
  readonly observedCanonicalHead?: string;
  readonly reconciledAt: string;
  readonly event: CampaignEvent;
}

export interface ChildResultRecord {
  readonly expectedVersion: number;
  readonly expectedStatus: CampaignStatus;
  readonly childSessionId: string;
  readonly event: CampaignEvent;
  readonly newCommitSha?: string;
  readonly operationResult?: CampaignOperationResult;
}

export interface CampaignOperationResult {
  readonly operation: "preflight" | "implement" | "verify" | "repair";
  readonly currentCommitSha: string;
  readonly pullRequest?: string;
  readonly qodoIteration: number;
}

export interface ApprovalIssuanceRecord {
  readonly approval: Approval;
  readonly idempotencyKey: string;
}

export interface CampaignStore {
  create(campaign: Campaign, initialEvent?: CampaignEvent): Promise<void>;
  get(id: string): Promise<CampaignSnapshot | undefined>;
  findByIssue(repository: string, issueNumber: number): Promise<CampaignSnapshot | undefined>;
  update(campaign: Campaign, expectedVersion: number): Promise<void>;
  listByStatus(status: CampaignStatus): Promise<readonly CampaignSnapshot[]>;
  appendEvidence(campaignId: string, evidence: Evidence): Promise<void>;
  appendEvent(campaignId: string, event: CampaignEvent): Promise<void>;
  recordApproval(approval: Approval): Promise<void>;
  issueApproval(record: ApprovalIssuanceRecord): Promise<Approval>;
  /** @deprecated Production orchestration must use claimExternalAction so approval consumption and the durable claim are atomic. */
  consumeApproval(
    approvalId: string,
    actionDigest: string,
    consumedAt: string,
    expectedCampaignVersion: number,
    expectedCampaignStatus: CampaignStatus,
  ): Promise<Approval>;
  recordQodoFinding(campaignId: string, iteration: number, finding: QodoFinding): Promise<void>;
  claimExternalAction(campaignId: string, record: ExternalActionClaimRecord): Promise<ExternalActionClaim>;
  completeExternalAction(campaignId: string, record: ExternalActionCompletionRecord): Promise<number>;
  markExternalActionOutcomeUnknown(campaignId: string, record: ExternalActionOutcomeUnknownRecord): Promise<void>;
  recoverStaleExternalActionClaim(campaignId: string, record: ExternalActionStaleRecoveryRecord): Promise<void>;
  reconcileExternalAction(campaignId: string, record: ExternalActionReconciliationRecord): Promise<number>;
  replaceCurrentCommit(
    campaignId: string,
    commitSha: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number>;
  replaceCurrentPullRequest(
    campaignId: string,
    pullRequest: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number>;
  recordChildResult(campaignId: string, record: ChildResultRecord): Promise<number>;
  setExternalReference(campaignId: string, reference: ExternalReference): Promise<void>;
}

export class CampaignVersionConflict extends Error {
  constructor(campaignId: string, expectedVersion: number) {
    super(`Campaign ${campaignId} is not at expected version ${String(expectedVersion)}`);
    this.name = "CampaignVersionConflict";
  }
}

export class CampaignIdentityConflict extends Error {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} identity is immutable`);
    this.name = "CampaignIdentityConflict";
  }
}

export class ApprovalIssuanceConflict extends Error {
  constructor() {
    super("Approval issuance conflicts with an existing human confirmation");
    this.name = "ApprovalIssuanceConflict";
  }
}

export const reservedCampaignEventTypes = new Set([
  "campaign_operation_completed",
  "external_action_attempted",
  "external_action_completed",
  "external_action_outcome_unknown",
  "external_action_reconciled",
  "external_action_stale_recovered",
]);
