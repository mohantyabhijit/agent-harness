import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  ApprovalIssuanceConflict,
  reservedCampaignEventTypes,
  type ApprovalIssuanceRecord,
  type CampaignOperationResult,
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
} from "../../src/application/ports/campaign-store.js";
import { parseQodoFinding } from "../../src/application/qodo-review-batch.js";
import { currentApprovalProposal } from "../../src/application/approval-proposal.js";
import { issueApproval as issueDomainApproval } from "../../src/domain/approval.js";
import { canonicalExternalActionJson, externalActionDigest, isPullRequest, validateExternalActionPayload, type ExternalActionPayload } from "../../src/application/external-action.js";
import {
  consumeApproval as consumeDomainApproval,
  isApprovalActionAllowed,
  type Approval,
} from "../../src/domain/approval.js";
import type { Campaign, CampaignStatus } from "../../src/domain/campaign.js";
import type { IssueBrief } from "../../src/domain/issue-brief.js";
import type { Evidence } from "../../src/domain/evidence.js";
import type { QodoFinding } from "../../src/domain/quality-gate.js";

interface MutableSnapshot {
  campaign: Campaign;
  evidence: Evidence[];
  events: CampaignEvent[];
  approvals: Approval[];
  qodoFindings: QodoFinding[];
  externalReferences: ExternalReference[];
  externalActionClaims: ExternalActionClaim[];
  operationResults: (CampaignOperationResult & { eventId: string; resultingCampaignVersion: number; childSessionId: string })[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validQodoOutcome(status: CampaignStatus, eventType: string): boolean {
  return (status === "qodo_review" && eventType === "quality_gate_passed") ||
    (status === "repair" && eventType === "quality_gate_repair_requested") ||
    (status === "human_escalation" && eventType === "quality_gate_escalated");
}

export class FakeCampaignStore implements CampaignStore {
  readonly #snapshots = new Map<string, MutableSnapshot>();
  readonly #findingIterations = new Map<string, number>();
  readonly #eventIds = new Set<string>();
  createBarrier?: () => Promise<void>;
  beforeConsumeApproval?: () => Promise<void>;
  beforeUpdate?: () => Promise<void>;
  failNextCreateEvent = false;
  failNextUpdate = false;
  failNextExternalReference = false;
  failNextEvent = false;
  failNextExternalCompletion = false;

  seed(campaign: Campaign): void {
    this.#insert(campaign);
  }

  async finalizeCampaign(campaignId: string, brief: IssueBrief, expectedVersion: number, event: CampaignEventInput): Promise<Campaign> {
    const snapshot = this.#required(campaignId);
    const requestedKey = isRecord(event.payload) ? event.payload.idempotencyKey : undefined;
    const prior = snapshot.events.find((candidate) => candidate.eventType === "campaign_finalized" && isRecord(candidate.payload) && candidate.payload.idempotencyKey === requestedKey);
    if (prior !== undefined) {
      if (!isRecord(prior.payload) || prior.payload.expectedVersion !== expectedVersion) throw new CampaignVersionConflict(campaignId, expectedVersion);
      return structuredClone(snapshot.campaign);
    }
    if (snapshot.campaign.version !== expectedVersion || snapshot.campaign.status !== "policy_review") throw new CampaignVersionConflict(campaignId, expectedVersion);
    this.#assertEventAvailable(event.id);
    if (this.failNextEvent) { this.failNextEvent = false; throw new Error("Campaign finalization persistence failed"); }
    const campaign = { ...snapshot.campaign, status: "coordination_pending" as const, version: expectedVersion + 1 };
    snapshot.campaign = campaign;
    this.#pushEvent(snapshot, { ...event, payload: { ...(isRecord(event.payload) ? event.payload : {}), brief: structuredClone(brief) } });
    this.#eventIds.add(event.id);
    return structuredClone(campaign);
  }

  seedExternalReference(campaignId: string, reference: ExternalReference): void {
    this.#required(campaignId).externalReferences.push(structuredClone(reference));
  }

  async create(campaign: Campaign, initialEvent?: CampaignEventInput): Promise<void> {
    await this.createBarrier?.();
    const initialEventClone = initialEvent === undefined ? undefined : structuredClone(initialEvent);
    if (initialEvent !== undefined) {
      this.#assertEventAvailable(initialEvent.id);
      if (this.failNextCreateEvent) {
        this.failNextCreateEvent = false;
        throw new Error("Initial campaign event could not be persisted");
      }
    }
    this.#insert(campaign);
    if (initialEventClone !== undefined) {
      this.#pushEvent(this.#required(campaign.id), initialEventClone);
      this.#eventIds.add(initialEventClone.id);
    }
  }

  async get(id: string, observedAt?: string): Promise<CampaignSnapshot | undefined> {
    const snapshot = this.#snapshots.get(id);
    if (snapshot !== undefined && observedAt !== undefined) {
      const canonicalObservedAt = canonicalTimestamp(observedAt, "approval observation");
      for (let index = 0; index < snapshot.approvals.length; index += 1) {
        const approval = snapshot.approvals[index];
        if (approval?.status === "approved" && approval.active === true && approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.parse(canonicalObservedAt)) {
          snapshot.approvals[index] = { ...approval, active: false };
        }
      }
    }
    return snapshot === undefined ? undefined : cloneSnapshot(snapshot);
  }

  async findByIssue(repository: string, issueNumber: number): Promise<CampaignSnapshot | undefined> {
    const normalizedRepository = repository.toLocaleLowerCase("en-US");
    for (const snapshot of this.#snapshots.values()) {
      if (
        snapshot.campaign.repository.toLocaleLowerCase("en-US") === normalizedRepository &&
        snapshot.campaign.issueNumber === issueNumber
      ) {
        return cloneSnapshot(snapshot);
      }
    }
    return undefined;
  }

  async update(campaign: Campaign, expectedVersion: number): Promise<void> {
    const beforeUpdate = this.beforeUpdate;
    delete this.beforeUpdate;
    await beforeUpdate?.();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new CampaignVersionConflict(campaign.id, expectedVersion);
    }
    const snapshot = this.#snapshots.get(campaign.id);
    if (snapshot !== undefined) this.#assertNoBlockingExternalAction(snapshot);
    if (
      snapshot === undefined ||
      snapshot.campaign.version !== expectedVersion ||
      campaign.version !== expectedVersion + 1
    ) {
      throw new CampaignVersionConflict(campaign.id, expectedVersion);
    }
    if (
      snapshot.campaign.repository !== campaign.repository ||
      snapshot.campaign.issueNumber !== campaign.issueNumber ||
      snapshot.campaign.issueUrl !== campaign.issueUrl ||
      snapshot.campaign.parentSessionId !== campaign.parentSessionId
    ) {
      throw new CampaignIdentityConflict(campaign.id);
    }
    snapshot.campaign = structuredClone(campaign);
  }

  async listByStatus(status: CampaignStatus): Promise<readonly CampaignSnapshot[]> {
    return [...this.#snapshots.values()]
      .filter((snapshot) => snapshot.campaign.status === status)
      .map(cloneSnapshot);
  }

  async appendEvidence(campaignId: string, evidence: Evidence): Promise<void> {
    this.#required(campaignId).evidence.push(structuredClone(evidence));
  }

  async appendEvent(campaignId: string, event: CampaignEventInput): Promise<void> {
    if (reservedCampaignEventTypes.has(event.eventType)) throw new Error("Authoritative campaign event requires its guarded store operation");
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    const snapshot = this.#required(campaignId);
    this.#assertEventAvailable(event.id);
    this.#pushEvent(snapshot, event);
    this.#eventIds.add(event.id);
  }

  async recordApproval(approval: Approval): Promise<void> {
    const snapshot = this.#required(approval.campaignId);
    if ([...this.#snapshots.values()].some((candidate) => candidate.approvals.some(({ id }) => id === approval.id))) {
      throw new Error(`Approval ${approval.id} already exists`);
    }
    snapshot.approvals.push(structuredClone({ ...approval, active: false, trustedProposalAuthority: false }));
  }

  readonly #approvalKeys = new Map<string, string>();

  async issueApproval(record: ApprovalIssuanceRecord): Promise<Approval> {
    if (record.idempotencyKey.length < 8 || record.idempotencyKey.length > 128) throw new ApprovalIssuanceConflict();
    const mapKey = `${record.approval.campaignId}\u0000${record.idempotencyKey}`;
    const snapshot = this.#required(record.approval.campaignId);
    const replayId = this.#approvalKeys.get(mapKey);
    if (replayId !== undefined) {
      const replay = snapshot.approvals.find(({ id }) => id === replayId);
      if (replay === undefined || replay.action !== record.approval.action || replay.actionDigest !== record.approval.actionDigest) throw new ApprovalIssuanceConflict();
      return structuredClone(replay);
    }
    if (snapshot.approvals.some(({ actionDigest, status, expiresAt }) => actionDigest === record.approval.actionDigest && status === "approved" && (expiresAt === undefined || Date.parse(expiresAt) > Date.parse(record.approval.issuedAt)))) throw new ApprovalIssuanceConflict();
    const inactive = { ...record.approval, active: false, trustedProposalAuthority: false } as const;
    await this.recordApproval(inactive);
    this.#approvalKeys.set(mapKey, record.approval.id);
    return structuredClone(inactive);
  }

  async issueApprovalForProposal(record: import("../../src/application/ports/campaign-store.js").ProposalApprovalIssuanceRecord): Promise<Approval> {
    if (record.idempotencyKey.length < 8 || record.idempotencyKey.length > 128) throw new ApprovalIssuanceConflict();
    const snapshot = this.#required(record.campaignId);
    const staged = structuredClone(snapshot);
    for (let index = 0; index < staged.approvals.length; index += 1) {
      const approval = staged.approvals[index];
      if (approval?.status === "approved" && approval.active === true && approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.parse(record.issuedAt)) {
        staged.approvals[index] = { ...approval, active: false };
      }
    }
    const mapKey = `${record.campaignId}\u0000${record.idempotencyKey}`;
    const replayId = this.#approvalKeys.get(mapKey);
    if (replayId !== undefined) {
      const replay = staged.approvals.find(({ id }) => id === replayId);
      if (replay === undefined || replay.proposalId !== record.proposalId || replay.actionDigest !== record.actionDigest || replay.expectedCampaignVersion !== record.expectedVersion) throw new ApprovalIssuanceConflict();
      this.#snapshots.set(record.campaignId, staged);
      return structuredClone(replay);
    }
    const proposal = currentApprovalProposal(cloneSnapshot(staged));
    if (proposal === null || proposal.proposalId !== record.proposalId || proposal.actionDigest !== record.actionDigest || proposal.expectedCampaignVersion !== record.expectedVersion) throw new ApprovalIssuanceConflict();
    const approval = issueDomainApproval({
      id: record.approvalId, campaignId: record.campaignId, action: proposal.payload.action, actionDigest: proposal.actionDigest,
      issuedAt: record.issuedAt, expiresAt: record.expiresAt, proposalId: proposal.proposalId,
      expectedCampaignVersion: proposal.expectedCampaignVersion, expectedCampaignStatus: proposal.expectedCampaignStatus,
      expectedCurrentCommitSha: proposal.expectedCurrentCommitSha ?? null, payload: structuredClone(proposal.payload),
      trustedProposalAuthority: true, active: true,
    });
    for (let index = 0; index < staged.approvals.length; index += 1) {
      const existing = staged.approvals[index];
      if (existing?.status === "approved" && existing.active === true &&
        (existing.expiresAt !== undefined && Date.parse(existing.expiresAt) <= Date.parse(record.issuedAt) ||
          existing.proposalId !== proposal.proposalId || existing.expectedCampaignVersion !== proposal.expectedCampaignVersion || existing.trustedProposalAuthority !== true)) {
        staged.approvals[index] = { ...existing, active: false };
      }
    }
    if (staged.approvals.some(({ actionDigest, status, active }) => actionDigest === approval.actionDigest && status === "approved" && active === true)) throw new ApprovalIssuanceConflict();
    if ([...this.#snapshots.values()].some((candidate) => candidate.approvals.some(({ id }) => id === approval.id))) throw new Error(`Approval ${approval.id} already exists`);
    staged.approvals.push(structuredClone(approval));
    this.#snapshots.set(record.campaignId, staged);
    this.#approvalKeys.set(mapKey, approval.id);
    return structuredClone(approval);
  }

  /** @deprecated Test compatibility only; orchestration claims through claimExternalAction. */
  async consumeApproval(
    approvalId: string,
    actionDigest: string,
    consumedAt: string,
    expectedCampaignVersion: number,
    expectedCampaignStatus: CampaignStatus,
  ): Promise<Approval> {
    const beforeConsume = this.beforeConsumeApproval;
    delete this.beforeConsumeApproval;
    await beforeConsume?.();
    for (const snapshot of this.#snapshots.values()) {
      const index = snapshot.approvals.findIndex((approval) => approval.id === approvalId);
      if (index !== -1) {
        const approval = snapshot.approvals[index];
        if (approval === undefined) {
          break;
        }
        if (snapshot.campaign.version !== expectedCampaignVersion) {
          throw new CampaignVersionConflict(snapshot.campaign.id, expectedCampaignVersion);
        }
        this.#assertNoBlockingExternalAction(snapshot);
        if (
          snapshot.campaign.status !== expectedCampaignStatus ||
          !isApprovalActionAllowed(approval.action, snapshot.campaign.status)
        ) {
          throw new Error("Campaign state does not allow this approval action");
        }
        const consumed = consumeDomainApproval(approval, actionDigest, consumedAt);
        snapshot.approvals[index] = consumed;
        return structuredClone(consumed);
      }
    }
    throw new Error(`Approval ${approvalId} does not exist`);
  }

  async recordQodoFinding(
    campaignId: string,
    iteration: number,
    finding: QodoFinding,
  ): Promise<void> {
    if (!Number.isInteger(iteration) || iteration < 1 || iteration > 3) {
      throw new TypeError("Invalid integer Qodo finding iteration; expected 1 to 3");
    }
    let parsedFinding: QodoFinding;
    try { parsedFinding = parseQodoFinding(finding); } catch { throw new TypeError("Invalid Qodo finding"); }
    const snapshot = this.#required(campaignId);
    const key = `${campaignId}\u0000${parsedFinding.id}`;
    const previousIteration = this.#findingIterations.get(key);
    if (previousIteration !== undefined && iteration < previousIteration) {
      throw new Error(`Stale Qodo finding iteration for ${parsedFinding.id}`);
    }
    const index = snapshot.qodoFindings.findIndex(({ id }) => id === parsedFinding.id);
    if (index === -1) {
      snapshot.qodoFindings.push(structuredClone(parsedFinding));
    } else {
      snapshot.qodoFindings[index] = structuredClone(parsedFinding);
    }
    this.#findingIterations.set(key, iteration);
  }

  async applyQodoReview(campaignId: string, record: QodoReviewClaimRecord): Promise<void> {
    record.persistenceLease?.assertCurrent();
    const beforeUpdate = this.beforeUpdate;
    delete this.beforeUpdate;
    await beforeUpdate?.();
    record.persistenceLease?.assertCurrent();
    const snapshot = this.#required(campaignId);
    this.#assertNoBlockingExternalAction(snapshot);
    this.#assertClaim(snapshot, campaignId, record.expectedVersion, "qodo_review");
    if (record.campaign.id !== campaignId || record.campaign.version !== record.expectedVersion + 1 ||
      record.reviewIteration !== snapshot.campaign.qodoIteration || singletonCommit(snapshot) !== record.expectedCommitSha ||
      singletonPullRequest(snapshot) !== record.expectedPullRequest) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
    if (record.campaign.repository !== snapshot.campaign.repository || record.campaign.issueNumber !== snapshot.campaign.issueNumber ||
      record.campaign.issueUrl !== snapshot.campaign.issueUrl || record.campaign.parentSessionId !== snapshot.campaign.parentSessionId) {
      throw new CampaignIdentityConflict(campaignId);
    }
    if (snapshot.events.some(({ eventType, payload }) => eventType === "qodo_review_claimed" && isRecord(payload) &&
      payload.reviewId === record.reviewId && payload.commitSha === record.expectedCommitSha && payload.reviewIteration === record.reviewIteration)) {
      throw new CampaignVersionConflict(campaignId, record.expectedVersion);
    }
    if (record.claimedEvent.eventType !== "qodo_review_claimed" || !validQodoOutcome(record.campaign.status, record.outcomeEvent.eventType) ||
      record.findings.some(({ event }) => event.eventType !== "qodo_finding_recorded")) throw new Error("Invalid atomic Qodo review events");
    const events = [record.claimedEvent, ...record.findings.map(({ event }) => event), record.outcomeEvent];
    for (const event of events) this.#assertEventAvailable(event.id);
    if (new Set(events.map(({ id }) => id)).size !== events.length) throw new Error("Duplicate atomic Qodo review event");
    const next = structuredClone(snapshot);
    const nextIterations = new Map(this.#findingIterations);
    for (const findingRecord of record.findings) {
      if (!Number.isInteger(findingRecord.iteration) || findingRecord.iteration < 1 || findingRecord.iteration > 3) throw new Error("Invalid Qodo finding iteration");
      const finding = parseQodoFinding(findingRecord.finding);
      const key = `${campaignId}\u0000${finding.id}`;
      const previousIteration = nextIterations.get(key);
      if (previousIteration !== undefined && findingRecord.iteration < previousIteration) throw new Error(`Stale Qodo finding iteration for ${finding.id}`);
      const index = next.qodoFindings.findIndex(({ id }) => id === finding.id);
      if (index === -1) next.qodoFindings.push(structuredClone(finding));
      else next.qodoFindings[index] = structuredClone(finding);
      nextIterations.set(key, findingRecord.iteration);
    }
    if (this.failNextUpdate || this.failNextEvent) {
      this.failNextUpdate = false;
      this.failNextEvent = false;
      throw new Error("Atomic Qodo review persistence failed");
    }
    next.campaign = structuredClone(record.campaign);
    for (const event of events) this.#pushEvent(next, structuredClone(event));
    this.#snapshots.set(campaignId, next);
    this.#findingIterations.clear();
    for (const [key, iteration] of nextIterations) this.#findingIterations.set(key, iteration);
    for (const event of events) this.#eventIds.add(event.id);
  }

  async escalateQodoReview(campaignId: string, record: QodoEscalationRecord): Promise<void> {
    record.persistenceLease?.assertCurrent();
    const snapshot = this.#required(campaignId);
    this.#assertClaim(snapshot, campaignId, record.expectedVersion, record.expectedStatus);
    this.#assertEventAvailable(record.event.id);
    if (record.event.eventType !== "quality_gate_escalated" || record.campaign.status !== "human_escalation" || record.campaign.version !== record.expectedVersion + 1) {
      throw new Error("Invalid Qodo escalation record");
    }
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    snapshot.campaign = structuredClone(record.campaign);
    this.#pushEvent(snapshot, record.event);
    this.#eventIds.add(record.event.id);
  }

  async claimExternalAction(campaignId: string, record: ExternalActionClaimRecord): Promise<ExternalActionClaim> {
    const beforeConsume = this.beforeConsumeApproval;
    delete this.beforeConsumeApproval;
    await beforeConsume?.();
    validateExternalActionPayload(record.payload);
    const consumedAt = canonicalTimestamp(record.consumedAt, "external action attempt");
    const leaseStartedAt = canonicalTimestamp(record.leaseStartedAt, "external action claim lease");
    const occurredAt = canonicalTimestamp(record.attemptedEvent.occurredAt, "campaign event");
    if (leaseStartedAt !== consumedAt || occurredAt !== leaseStartedAt) throw new Error("External action claim lease is not bound to its attempt");
    const snapshot = this.#required(campaignId);
    this.#assertClaim(snapshot, campaignId, record.expectedVersion, record.expectedStatus);
    this.#assertNoBlockingExternalAction(snapshot);
    if (record.attemptedEvent.eventType !== "external_action_attempted") throw new Error("Invalid external action attempted event");
    assertExternalActionEventVersion(record.attemptedEvent.payload, record.expectedVersion, record.expectedVersion);
    const currentCommitSha = singletonCommit(snapshot);
    if (currentCommitSha !== record.expectedCurrentCommitSha) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
    if (record.payload.action === "push_branch" && currentCommitSha === undefined) throw new Error("Branch push requires a current campaign head");
    if ((record.payload.action === "create_pr" || record.payload.action === "update_pr") && record.payload.commitSha !== currentCommitSha) throw new Error("External action commit does not match current campaign head");
    const repairVerificationReceipt = record.payload.action === "update_pr" ? assertUpdatePullRequestIdentity(snapshot, record.payload) : undefined;
    if (externalActionDigest(record.payload) !== record.actionDigest) throw new Error("External action payload digest does not match claim");
    const approvalIndex = snapshot.approvals.findIndex(({ id }) => id === record.approvalId);
    const approval = snapshot.approvals[approvalIndex];
    if (approval?.active === true && approval.trustedProposalAuthority === true && approval.expiresAt !== undefined && Date.parse(approval.expiresAt) <= Date.parse(consumedAt)) {
      snapshot.approvals[approvalIndex] = { ...approval, active: false };
      throw new Error("Approval is not available because it expired");
    }
    if (approval?.active === true && approval.trustedProposalAuthority === true) {
      const proposal = currentApprovalProposal(cloneSnapshot(snapshot));
      if (!approvalMatchesProposal(approval, proposal)) {
        snapshot.approvals[approvalIndex] = { ...approval, status: "rejected", active: false };
        throw new Error("External action does not match the current approved proposal authority");
      }
    }
    if (approval === undefined || approval.active !== true || approval.trustedProposalAuthority !== true || approval.campaignId !== campaignId || approval.proposalId === undefined || approval.payload === undefined ||
      approval.expectedCampaignVersion !== snapshot.campaign.version || approval.expectedCampaignStatus !== snapshot.campaign.status ||
      approval.expectedCurrentCommitSha !== (currentCommitSha ?? null) || approval.actionDigest !== record.actionDigest ||
      canonicalExternalActionJson(approval.payload as import("../../src/application/external-action.js").ExternalActionPayload) !== canonicalExternalActionJson(record.payload)) throw new Error("External action does not match the approved proposal authority");
    validateExternalActionPayload(approval.payload as import("../../src/application/external-action.js").ExternalActionPayload);
    if (!isApprovalActionAllowed(approval.action, approval.expectedCampaignStatus)) throw new Error("Campaign state does not allow this approval action");
    const consumed = consumeDomainApproval(approval, record.actionDigest, record.consumedAt);
    this.#assertEventAvailable(record.attemptedEvent.id);
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    if ([...this.#snapshots.values()].some((candidate) => candidate.externalActionClaims.some(({ id }) => id === record.claimId))) throw new Error(`External action claim ${record.claimId} already exists`);
    if ([...this.#snapshots.values()].some((candidate) => candidate.externalActionClaims.some(({ approvalId }) => approvalId === record.approvalId))) throw new Error("Approval already has an external action claim");
    const claim: ExternalActionClaim = {
      id: record.claimId,
      campaignId,
      approvalId: record.approvalId,
      actionDigest: record.actionDigest,
      payload: structuredClone(approval.payload as import("../../src/application/external-action.js").ExternalActionPayload),
      ...(currentCommitSha === undefined ? {} : { currentCommitSha }),
      claimedCampaignVersion: record.expectedVersion,
      claimedCampaignStatus: record.expectedStatus,
      status: "active",
      attemptedAt: consumedAt,
      leaseStartedAt,
      ...(repairVerificationReceipt === undefined ? {} : { repairVerificationReceipt }),
    };
    const durableConsumed = structuredClone({ ...consumed, active: false });
    const durableClaim = structuredClone(claim);
    const durableEvent = structuredClone(record.attemptedEvent);
    snapshot.approvals[approvalIndex] = durableConsumed;
    snapshot.externalActionClaims.push(durableClaim);
    this.#pushEvent(snapshot, durableEvent);
    this.#eventIds.add(record.attemptedEvent.id);
    return structuredClone(claim);
  }

  async completeExternalAction(campaignId: string, record: ExternalActionCompletionRecord): Promise<number> {
    if (this.failNextExternalCompletion) {
      this.failNextExternalCompletion = false;
      throw new Error("External completion persistence failed");
    }
    const snapshot = this.#required(campaignId);
    const claim = this.#requiredExternalActionClaim(snapshot, record.claimId, "active");
    this.#assertClaim(snapshot, campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
    if (singletonCommit(snapshot) !== claim.currentCommitSha) throw new Error("External action current head changed after claim");
    this.#assertEventAvailable(record.completedEvent.id);
    if (record.completedEvent.eventType !== "external_action_completed") throw new Error("Invalid external action completed event");
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    const headVersion = this.#validatedExternalActionHeadVersion(claim, snapshot, record.newCommitSha);
    const returnsToReview = claim.payload.action === "update_pr";
    const opensPullRequest = claim.payload.action === "create_pr" && record.publishedReference?.kind === "pull_request";
    const resultingVersion = returnsToReview || opensPullRequest ? snapshot.campaign.version + 1 : headVersion;
    assertExternalActionEventVersion(record.completedEvent.payload, claim.claimedCampaignVersion, resultingVersion);
    if (record.nextProposalEvent !== undefined) {
      this.#assertEventAvailable(record.nextProposalEvent.id);
      if (record.nextProposalEvent.id === record.completedEvent.id) throw new Error("Follow-up proposal event must have a distinct id");
      if (claim.payload.action !== "push_branch" || record.newCommitSha === undefined) throw new Error("Follow-up proposal requires a completed branch push");
      assertProposalEvent(record.nextProposalEvent, resultingVersion, claim.claimedCampaignStatus, claim.payload.repository, claim.payload.issueNumber, record.newCommitSha, "create_pr", claim.payload.branch);
    }
    if (record.newCommitSha !== undefined && singletonCommit(snapshot) !== record.newCommitSha) {
      snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit");
      snapshot.externalReferences.push({ kind: "commit", value: record.newCommitSha });
      snapshot.campaign = { ...snapshot.campaign, version: resultingVersion };
    }
    if (record.publishedReference !== undefined) this.#recordPublishedReference(snapshot, claim.payload, record.publishedReference);
    if (returnsToReview) snapshot.campaign = { ...snapshot.campaign, status: "qodo_review", version: resultingVersion };
    if (opensPullRequest) snapshot.campaign = { ...snapshot.campaign, status: "pull_request_open", version: resultingVersion };
    this.#pushEvent(snapshot, record.completedEvent);
    this.#eventIds.add(record.completedEvent.id);
    if (record.nextProposalEvent !== undefined) {
      this.#pushEvent(snapshot, record.nextProposalEvent);
      this.#eventIds.add(record.nextProposalEvent.id);
    }
    Object.assign(claim, { status: "completed", closedAt: record.completedAt });
    return resultingVersion;
  }

  async markExternalActionOutcomeUnknown(campaignId: string, record: ExternalActionOutcomeUnknownRecord): Promise<void> {
    const snapshot = this.#required(campaignId);
    const claim = this.#requiredExternalActionClaim(snapshot, record.claimId, "active");
    this.#assertEventAvailable(record.event.id);
    if (record.event.eventType !== "external_action_outcome_unknown") throw new Error("Invalid external action outcome event");
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    this.#pushEvent(snapshot, record.event);
    this.#eventIds.add(record.event.id);
    Object.assign(claim, { status: "outcome_unknown" });
  }

  async recoverStaleExternalActionClaim(campaignId: string, record: ExternalActionStaleRecoveryRecord): Promise<void> {
    const snapshot = this.#required(campaignId);
    const claim = this.#requiredExternalActionClaim(snapshot, record.claimId, "active");
    const staleBefore = canonicalTimestamp(record.staleBefore, "stale claim threshold");
    const recoveredAt = canonicalTimestamp(record.recoveredAt, "stale claim recovery");
    const occurredAt = canonicalTimestamp(record.event.occurredAt, "campaign event");
    if (recoveredAt !== occurredAt) throw new Error("Stale claim recovery event timestamp does not match recovery");
    if (record.operatorDisposition.trim().length === 0) throw new Error("Stale claim recovery disposition is required");
    if (record.event.eventType !== "external_action_stale_recovered") throw new Error("Invalid stale external action recovery event");
    assertStaleRecoveryEvent(record.event, claim);
    if (Date.parse(claim.leaseStartedAt) > Date.parse(staleBefore)) throw new Error("External action claim is not stale");
    this.#assertClaim(snapshot, campaignId, claim.claimedCampaignVersion, claim.claimedCampaignStatus);
    if (singletonCommit(snapshot) !== claim.currentCommitSha) throw new Error("External action current head changed after claim");
    this.#assertEventAvailable(record.event.id);
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    this.#pushEvent(snapshot, record.event);
    this.#eventIds.add(record.event.id);
    Object.assign(claim, { status: "outcome_unknown" });
  }

  async reconcileExternalAction(campaignId: string, record: ExternalActionReconciliationRecord): Promise<number> {
    const snapshot = this.#required(campaignId);
    const claim = this.#requiredExternalActionClaim(snapshot, record.claimId, "outcome_unknown");
    this.#assertEventAvailable(record.event.id);
    if (record.event.eventType !== "external_action_reconciled") throw new Error("Invalid external action reconciliation event");
    if (record.observedCanonicalHead !== undefined) assertCommitSha(record.observedCanonicalHead);
    const current = singletonCommit(snapshot);
    const preserveVerifiedRepair = record.disposition === "confirmed_not_completed" && claim.payload.action === "update_pr";
    const changed = !preserveVerifiedRepair && record.observedCanonicalHead !== undefined && record.observedCanonicalHead !== current;
    const confirmedUpdate = record.disposition === "confirmed_completed" && claim.payload.action === "update_pr";
    const confirmedCreate = record.disposition === "confirmed_completed" && claim.payload.action === "create_pr";
    if (confirmedUpdate && (record.observedCanonicalHead !== claim.payload.commitSha || current !== claim.payload.commitSha || snapshot.campaign.status !== "repair" || singletonPullRequest(snapshot) !== claim.payload.pullRequest)) {
      throw new Error("Confirmed update_pr reconciliation does not match current authority");
    }
    if (confirmedCreate && (record.observedPullRequest === undefined || !isPullRequest(record.observedPullRequest, claim.payload.repository) || current !== claim.payload.commitSha || snapshot.campaign.status !== "contribution_approval")) {
      throw new Error("Confirmed create_pr reconciliation does not match current authority");
    }
    const resultingVersion = snapshot.campaign.version + (changed || confirmedUpdate || confirmedCreate ? 1 : 0);
    assertExternalActionEventVersion(record.event.payload, snapshot.campaign.version, resultingVersion);
    if (record.nextProposalEvent !== undefined) {
      if (record.nextProposalEvent.id === record.event.id) throw new Error("Follow-up proposal event must have a distinct id");
      if (this.#eventIds.has(record.nextProposalEvent.id)) throw new Error(`Duplicate campaign event id: ${record.nextProposalEvent.id}`);
      if (claim.payload.action !== "push_branch" || record.disposition !== "confirmed_completed") throw new Error("Follow-up proposal requires a confirmed completed branch push");
      assertProposalEvent(record.nextProposalEvent, resultingVersion, claim.claimedCampaignStatus, claim.payload.repository, claim.payload.issueNumber, claim.payload.commitSha, "create_pr", claim.payload.branch);
    }
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    if (changed) {
      snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit");
      snapshot.externalReferences.push({ kind: "commit", value: record.observedCanonicalHead });
    }
    if (record.disposition === "confirmed_completed" && claim.payload.action === "push_branch") this.#recordPublishedReference(snapshot, claim.payload, { kind: "branch", value: claim.payload.branch });
    if (confirmedCreate && record.observedPullRequest !== undefined) this.#recordPublishedReference(snapshot, claim.payload, { kind: "pull_request", value: record.observedPullRequest });
    if (changed || confirmedUpdate || confirmedCreate) snapshot.campaign = { ...snapshot.campaign, version: resultingVersion, ...(confirmedUpdate ? { status: "qodo_review" as const } : confirmedCreate ? { status: "pull_request_open" as const } : {}) };
    this.#pushEvent(snapshot, record.event);
    this.#eventIds.add(record.event.id);
    if (record.nextProposalEvent !== undefined) {
      this.#pushEvent(snapshot, record.nextProposalEvent);
      this.#eventIds.add(record.nextProposalEvent.id);
    }
    Object.assign(claim, {
      status: "reconciled",
      closedAt: record.reconciledAt,
      disposition: record.disposition,
      ...(record.observedCanonicalHead === undefined ? {} : { observedCanonicalHead: record.observedCanonicalHead }),
    });
    return resultingVersion;
  }

  async setExternalReference(campaignId: string, reference: ExternalReference): Promise<void> {
    if (this.failNextExternalReference) {
      this.failNextExternalReference = false;
      throw new Error("External reference persistence failed");
    }
    const snapshot = this.#required(campaignId);
    if (reference.kind === "commit") throw new Error("Current commit requires a versioned replacement");
    if (reference.kind === "pull_request") throw new Error("Current pull request requires a versioned replacement");
    if (
      !snapshot.externalReferences.some(
        (candidate) => candidate.kind === reference.kind && candidate.value === reference.value,
      )
    ) {
      snapshot.externalReferences.push(structuredClone(reference));
    }
  }

  async replaceCurrentPullRequest(
    campaignId: string,
    pullRequest: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number> {
    const snapshot = this.#required(campaignId);
    if (!isPullRequest(pullRequest, snapshot.campaign.repository)) throw new Error("Invalid current pull request");
    if (!statusesAllowingIndependentPullRequestReplacement.has(expectedStatus)) throw new Error(`Campaign status ${expectedStatus} does not allow independent current pull request replacement`);
    this.#assertNoBlockingExternalAction(snapshot);
    this.#assertClaim(snapshot, campaignId, expectedVersion, expectedStatus);
    const current = singletonPullRequest(snapshot);
    if (current === pullRequest) return expectedVersion;
    snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "pull_request");
    snapshot.externalReferences.push({ kind: "pull_request", value: pullRequest });
    snapshot.campaign = { ...snapshot.campaign, version: expectedVersion + 1 };
    return expectedVersion + 1;
  }

  async replaceCurrentCommit(
    campaignId: string,
    commitSha: string,
    expectedVersion: number,
    expectedStatus: CampaignStatus,
  ): Promise<number> {
    assertCommitSha(commitSha);
    const snapshot = this.#required(campaignId);
    if (!statusesAllowingIndependentCommitReplacement.has(expectedStatus)) throw new Error(`Campaign status ${expectedStatus} does not allow independent current commit replacement`);
    this.#assertNoBlockingExternalAction(snapshot);
    this.#assertClaim(snapshot, campaignId, expectedVersion, expectedStatus);
    if (this.failNextExternalReference) {
      this.failNextExternalReference = false;
      throw new Error("External reference persistence failed");
    }
    const current = snapshot.externalReferences.find(({ kind }) => kind === "commit")?.value;
    if (current === commitSha) return expectedVersion;
    snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit");
    snapshot.externalReferences.push({ kind: "commit", value: commitSha });
    snapshot.campaign = { ...snapshot.campaign, version: expectedVersion + 1 };
    return expectedVersion + 1;
  }

  async recordChildResult(campaignId: string, record: ChildResultRecord): Promise<number> {
    record.persistenceLease?.assertCurrent();
    if (record.childSessionId.trim().length === 0) throw new Error("Invalid child session identifier");
    if (record.newCommitSha !== undefined) assertCommitSha(record.newCommitSha);
    const snapshot = this.#required(campaignId);
    this.#assertNoBlockingExternalAction(snapshot);
    this.#assertClaim(snapshot, campaignId, record.expectedVersion, record.expectedStatus);
    this.#assertEventAvailable(record.event.id);
    if (this.failNextExternalReference) {
      this.failNextExternalReference = false;
      throw new Error("External reference persistence failed");
    }
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    let resultingVersion = record.expectedVersion;
    const current = snapshot.externalReferences.find(({ kind }) => kind === "commit")?.value;
    if (record.newCommitSha !== undefined && current !== record.newCommitSha) resultingVersion += 1;
    assertChildEventVersion(record.event.payload, record.expectedVersion, resultingVersion);
    if (record.nextCampaign !== undefined || record.nextProposalEvent !== undefined) {
      if (record.nextCampaign === undefined || record.nextProposalEvent === undefined) throw new Error("Next campaign and proposal must be persisted together");
      if (record.newCommitSha !== undefined || record.expectedStatus !== "verification" || record.event.eventType !== "campaign_operation_completed" || record.operationResult?.operation !== "verify") throw new Error("Contribution approval requires a completed verification without a new commit");
      if (record.nextCampaign.version !== resultingVersion + 1 || record.nextCampaign.status !== "contribution_approval") throw new Error("Invalid contribution approval campaign transition");
      if (record.nextCampaign.id !== snapshot.campaign.id || record.nextCampaign.repository !== snapshot.campaign.repository || record.nextCampaign.issueNumber !== snapshot.campaign.issueNumber || record.nextCampaign.issueUrl !== snapshot.campaign.issueUrl || record.nextCampaign.parentSessionId !== snapshot.campaign.parentSessionId || record.nextCampaign.lane !== snapshot.campaign.lane || record.nextCampaign.qodoIteration !== snapshot.campaign.qodoIteration) throw new Error("Contribution approval campaign identity changed");
      assertProposalEvent(record.nextProposalEvent, record.nextCampaign.version, record.nextCampaign.status, snapshot.campaign.repository, snapshot.campaign.issueNumber, current, "push_branch");
    }
    const nextReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit" || record.newCommitSha === undefined);
    if (record.newCommitSha !== undefined) nextReferences.push({ kind: "commit", value: record.newCommitSha });
    const childReferences = { child_session: record.childSessionId, sandbox: record.sandboxSessionId ?? record.childSessionId } as const;
    for (const kind of ["child_session", "sandbox"] as const) {
      const value = childReferences[kind];
      if (!nextReferences.some((reference) => reference.kind === kind && reference.value === value)) nextReferences.push({ kind, value });
    }
    if (record.event.eventType === "campaign_operation_completed") {
      const result = record.operationResult;
      const resultingCommit = nextReferences.find(({ kind }) => kind === "commit")?.value;
      if (result === undefined || result.currentCommitSha !== resultingCommit) throw new Error("Completed child result lacks typed operation authority");
      if (result.qodoIteration !== snapshot.campaign.qodoIteration) throw new Error("Operation result Qodo iteration does not match campaign");
      if (result.operation === "repair" && (result.pullRequest === undefined || !isPullRequest(result.pullRequest, snapshot.campaign.repository) || singletonPullRequest(snapshot) !== result.pullRequest || !validRepairAuthority(result.repairVerification, campaignId, snapshot.campaign.repository, result.pullRequest, record.childSessionId, record.sandboxSessionId, result.currentCommitSha))) throw new Error("Repair result lacks exact verified publication authority");
      snapshot.operationResults.push({ ...structuredClone(result), eventId: record.event.id, resultingCampaignVersion: resultingVersion, childSessionId: record.childSessionId });
    } else if (record.operationResult !== undefined) throw new Error("Typed operation authority requires a completed child event");
    snapshot.externalReferences = nextReferences;
    this.#pushEvent(snapshot, record.event);
    this.#eventIds.add(record.event.id);
    if (record.nextCampaign !== undefined) snapshot.campaign = structuredClone(record.nextCampaign);
    else if (resultingVersion !== record.expectedVersion) snapshot.campaign = { ...snapshot.campaign, version: resultingVersion };
    if (record.nextProposalEvent !== undefined) {
      this.#pushEvent(snapshot, record.nextProposalEvent);
      this.#eventIds.add(record.nextProposalEvent.id);
    }
    return record.nextCampaign?.version ?? resultingVersion;
  }

  #recordPublishedReference(snapshot: MutableSnapshot, payload: ExternalActionPayload, reference: ExternalReference): void {
    if (payload.action === "push_branch" && reference.kind === "branch" && reference.value === payload.branch) {
      if (!snapshot.externalReferences.some((candidate) => candidate.kind === reference.kind && candidate.value === reference.value)) snapshot.externalReferences.push(structuredClone(reference));
      return;
    }
    if (payload.action === "create_pr" && reference.kind === "pull_request" && isPullRequest(reference.value, payload.repository)) {
      const current = singletonPullRequest(snapshot);
      if (current !== undefined && current !== reference.value) throw new Error("Campaign already has a different pull request");
      if (current === undefined) snapshot.externalReferences.push(structuredClone(reference));
      return;
    }
    throw new Error("Published reference does not match the claimed external action");
  }

  #assertClaim(snapshot: MutableSnapshot, campaignId: string, expectedVersion: number, expectedStatus: CampaignStatus): void {
    if (snapshot.campaign.version !== expectedVersion || snapshot.campaign.status !== expectedStatus) throw new CampaignVersionConflict(campaignId, expectedVersion);
  }

  #assertNoBlockingExternalAction(snapshot: MutableSnapshot): void {
    if (snapshot.externalActionClaims.some(({ status }) => status === "active" || status === "outcome_unknown")) throw new Error("Campaign has a blocking external action claim");
  }

  #requiredExternalActionClaim(snapshot: MutableSnapshot, claimId: string, status: ExternalActionClaim["status"]): ExternalActionClaim {
    const claim = snapshot.externalActionClaims.find(({ id }) => id === claimId);
    if (claim === undefined || claim.status !== status) throw new Error(`External action claim ${claimId} is not ${status}`);
    return claim;
  }

  #validatedExternalActionHeadVersion(claim: ExternalActionClaim, snapshot: MutableSnapshot, newCommitSha?: string): number {
    if (newCommitSha === undefined) return snapshot.campaign.version;
    assertCommitSha(newCommitSha);
    if ((claim.payload.action !== "push_branch" && claim.payload.action !== "update_pr") || claim.payload.commitSha !== newCommitSha) throw new Error("External action completion commit does not match claimed payload");
    return snapshot.campaign.version + (singletonCommit(snapshot) === newCommitSha ? 0 : 1);
  }

  #insert(campaign: Campaign): void {
    if (
      !Number.isInteger(campaign.version) ||
      campaign.version < 1 ||
      !Number.isInteger(campaign.qodoIteration) ||
      campaign.qodoIteration < 0 ||
      campaign.qodoIteration > 3
    ) {
      throw new Error("Campaign could not be created");
    }
    if (this.#snapshots.has(campaign.id)) {
      throw new Error("Campaign could not be created");
    }
    const normalizedRepository = campaign.repository.toLocaleLowerCase("en-US");
    if (
      [...this.#snapshots.values()].some(
        (snapshot) =>
          snapshot.campaign.repository.toLocaleLowerCase("en-US") === normalizedRepository &&
          snapshot.campaign.issueNumber === campaign.issueNumber,
      )
    ) {
      throw new Error("Campaign already exists for this repository issue");
    }
    this.#snapshots.set(campaign.id, {
      campaign: structuredClone(campaign),
      evidence: [],
      events: [],
      approvals: [],
      qodoFindings: [],
      externalReferences: [],
      externalActionClaims: [],
      operationResults: [],
    });
  }

  #required(campaignId: string): MutableSnapshot {
    const snapshot = this.#snapshots.get(campaignId);
    if (snapshot === undefined) {
      throw new Error(`Campaign ${campaignId} does not exist`);
    }
    return snapshot;
  }

  #assertEventAvailable(eventId: string): void {
    if (this.#eventIds.has(eventId)) {
      throw new Error(`Campaign event ${eventId} already exists`);
    }
  }

  #pushEvent(snapshot: MutableSnapshot, event: CampaignEventInput): void {
    const sequence = (snapshot.events.at(-1)?.sequence ?? 0) + 1;
    snapshot.events.push({ ...structuredClone(event), sequence });
  }
}

function cloneSnapshot(snapshot: MutableSnapshot): CampaignSnapshot {
  const seen = new Set<number>();
  for (const event of snapshot.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || seen.has(event.sequence)) throw new Error("Campaign event sequence is invalid");
    seen.add(event.sequence);
  }
  return structuredClone({
    campaign: snapshot.campaign,
    evidence: snapshot.evidence,
    events: snapshot.events,
    approvals: snapshot.approvals,
    qodoFindings: snapshot.qodoFindings,
    externalReferences: snapshot.externalReferences,
    externalActionClaims: snapshot.externalActionClaims,
  });
}

function approvalMatchesProposal(approval: Approval, proposal: ReturnType<typeof currentApprovalProposal>): boolean {
  if (proposal === null || approval.payload === undefined) return false;
  return approval.proposalId === proposal.proposalId && approval.action === proposal.payload.action &&
    approval.actionDigest === proposal.actionDigest && approval.expectedCampaignVersion === proposal.expectedCampaignVersion &&
    approval.expectedCampaignStatus === proposal.expectedCampaignStatus && approval.expectedCurrentCommitSha === (proposal.expectedCurrentCommitSha ?? null) &&
    canonicalExternalActionJson(approval.payload as import("../../src/application/external-action.js").ExternalActionPayload) === canonicalExternalActionJson(proposal.payload);
}

function assertCommitSha(commitSha: string): void {
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Invalid current commit SHA");
}

function validRepairAuthority(
  value: import("../../src/application/ports/campaign-store.js").RepairVerificationAuthority | undefined,
  campaignId: string,
  repository: string,
  pullRequest: string,
  childSessionId: string,
  sandboxSessionId: string | undefined,
  commitSha: string,
): boolean {
  return value !== undefined && (value as unknown as Record<string, unknown>).testsPassed === true && value.receipt === value.receipt.trim() && value.receipt.length >= 16 && value.receipt.length <= 512 && value.campaignId === campaignId && value.repository === repository &&
    value.pullRequest === pullRequest && value.childSessionId === childSessionId && value.sandboxSessionId === sandboxSessionId &&
    value.candidateCommitSha === commitSha && value.expectedParentCommitSha !== commitSha && value.testPolicy === "openquest-repair-tests-v1" &&
    value.commands.length > 0 && value.commands.length <= 100 && value.commands.every((command) => command.trim().length > 0 && command.length <= 2_000) &&
    value.evidence.length > 0 && value.evidence.length <= 100 && value.evidence.every((evidence) => (evidence as unknown as Record<string, unknown>).kind === "direct" && evidence.sourceUrl.length <= 2_048 && evidence.observation.trim().length > 0 && evidence.observation.length <= 2_000);
}

function canonicalTimestamp(value: string, label: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new TypeError(`Invalid ${label} timestamp`);
  return new Date(instant).toISOString();
}

function assertChildEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion ||
    !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion
  ) throw new Error("Child result event is not bound to the campaign version");
}

function singletonCommit(snapshot: MutableSnapshot): string | undefined {
  const commits = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
  if (commits.length > 1) throw new Error("Campaign current commit is ambiguous");
  return commits[0]?.value;
}

function singletonPullRequest(snapshot: MutableSnapshot): string | undefined {
  const pullRequests = snapshot.externalReferences.filter(({ kind }) => kind === "pull_request");
  if (pullRequests.length > 1) throw new Error("Campaign current pull request is ambiguous");
  return pullRequests[0]?.value;
}

function assertUpdatePullRequestIdentity(
  snapshot: MutableSnapshot,
  payload: Extract<import("../../src/application/external-action.js").ExternalActionPayload, { action: "update_pr" }>,
): string {
  const pullRequests = snapshot.externalReferences.filter(({ kind }) => kind === "pull_request");
  if (pullRequests.length !== 1 || pullRequests[0]?.value !== payload.pullRequest || !isPullRequest(payload.pullRequest, snapshot.campaign.repository)) {
    throw new Error("External action pull request does not match campaign memory");
  }
  const matches = snapshot.operationResults.filter((result) => result.operation === "repair" && result.repairVerification !== undefined &&
    result.resultingCampaignVersion === snapshot.campaign.version && result.currentCommitSha === payload.commitSha &&
    result.pullRequest === payload.pullRequest && result.qodoIteration === snapshot.campaign.qodoIteration);
  if (matches.length !== 1) throw new Error("Campaign lacks one unambiguous repair completion event for this update");
  const receipt = matches[0]?.repairVerification?.receipt;
  if (receipt === undefined) throw new Error("Campaign repair verification receipt is missing");
  return receipt;
}

function assertExternalActionEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion || !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion) throw new Error("External action event is not bound to the campaign version");
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
  if (event.eventType !== "external_action_proposed" || typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) throw new Error("Invalid external action proposal event");
  const payload = event.payload as Record<string, unknown>;
  const proposalKeys = ["proposalId", "payload", "actionDigest", "expectedCampaignVersion", "expectedCampaignStatus", "expectedCurrentCommitSha", "brief"];
  if (Object.keys(payload).some((key) => !proposalKeys.includes(key)) || Object.keys(payload).length !== proposalKeys.length || payload.proposalId !== event.id || payload.expectedCampaignVersion !== expectedVersion || payload.expectedCampaignStatus !== expectedStatus || payload.expectedCurrentCommitSha !== expectedCommitSha) throw new Error("External action proposal is not bound to the campaign version");
  if (typeof payload.payload !== "object" || payload.payload === null || Array.isArray(payload.payload)) throw new Error("External action proposal payload is invalid");
  const action = payload.payload as ExternalActionPayload;
  validateExternalActionPayload(action);
  if (action.action !== expectedAction || action.repository !== repository || action.issueNumber !== issueNumber || externalActionDigest(action) !== payload.actionDigest) throw new Error("External action proposal identity is invalid");
  if (expectedCommitSha === undefined || (action.action === "push_branch" ? action.commitSha !== expectedCommitSha : action.commitSha !== expectedCommitSha)) throw new Error("External action proposal commit is not current");
  if (expectedBranch !== undefined && (action.action !== "create_pr" || action.branch !== expectedBranch)) throw new Error("Follow-up proposal branch does not match push");
  const brief = payload.brief;
  if (typeof brief !== "object" || brief === null || Array.isArray(brief)) throw new Error("External action proposal brief is invalid");
  const briefRecord = brief as Record<string, unknown>;
  const briefKeys = ["policy", "approach", "files", "risks", "tests", "safetyResult", "qodoStatus", "aiDisclosure"];
  if (Object.keys(briefRecord).some((key) => !briefKeys.includes(key)) || Object.keys(briefRecord).length !== briefKeys.length) throw new Error("External action proposal brief is invalid");
  for (const key of ["policy", "approach", "safetyResult", "qodoStatus", "aiDisclosure"]) if (typeof briefRecord[key] !== "string" || briefRecord[key].trim().length < 3 || briefRecord[key].length > 20_000) throw new Error("External action proposal brief is invalid");
  for (const key of ["files", "risks", "tests"]) if (!Array.isArray(briefRecord[key]) || briefRecord[key].length === 0 || briefRecord[key].length > 200 || !(briefRecord[key] as unknown[]).every((item) => typeof item === "string" && item.trim().length >= 1 && item.length <= 20_000)) throw new Error("External action proposal brief is invalid");
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
