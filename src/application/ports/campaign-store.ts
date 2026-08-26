import type { Approval } from "../../domain/approval.js";
import type { Campaign, CampaignStatus } from "../../domain/campaign.js";
import type { Evidence } from "../../domain/evidence.js";
import type { QodoFinding } from "../../domain/quality-gate.js";

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
}

export interface CampaignStore {
  create(campaign: Campaign): Promise<void>;
  get(id: string): Promise<CampaignSnapshot | undefined>;
  findByIssue(repository: string, issueNumber: number): Promise<CampaignSnapshot | undefined>;
  update(campaign: Campaign, expectedVersion: number): Promise<void>;
  listByStatus(status: CampaignStatus): Promise<readonly CampaignSnapshot[]>;
  appendEvidence(campaignId: string, evidence: Evidence): Promise<void>;
  appendEvent(campaignId: string, event: CampaignEvent): Promise<void>;
  recordApproval(approval: Approval): Promise<void>;
  consumeApproval(approvalId: string, actionDigest: string, consumedAt: string): Promise<Approval>;
  recordQodoFinding(campaignId: string, iteration: number, finding: QodoFinding): Promise<void>;
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
