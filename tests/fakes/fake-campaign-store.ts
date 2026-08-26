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
  type ExternalActionStaleRecoveryRecord,
  type ExternalReference,
} from "../../src/application/ports/campaign-store.js";
import { externalActionDigest, validateExternalActionPayload } from "../../src/application/external-action.js";
import {
  consumeApproval as consumeDomainApproval,
  isApprovalActionAllowed,
  type Approval,
} from "../../src/domain/approval.js";
import type { Campaign, CampaignStatus } from "../../src/domain/campaign.js";
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

  seed(campaign: Campaign): void {
    this.#insert(campaign);
  }

  seedExternalReference(campaignId: string, reference: ExternalReference): void {
    this.#required(campaignId).externalReferences.push(structuredClone(reference));
  }

  async create(campaign: Campaign, initialEvent?: CampaignEvent): Promise<void> {
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
      this.#required(campaign.id).events.push(initialEventClone);
      this.#eventIds.add(initialEventClone.id);
    }
  }

  async get(id: string): Promise<CampaignSnapshot | undefined> {
    const snapshot = this.#snapshots.get(id);
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

  async appendEvent(campaignId: string, event: CampaignEvent): Promise<void> {
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    const snapshot = this.#required(campaignId);
    this.#assertEventAvailable(event.id);
    snapshot.events.push(structuredClone(event));
    this.#eventIds.add(event.id);
  }

  async recordApproval(approval: Approval): Promise<void> {
    const snapshot = this.#required(approval.campaignId);
    if ([...this.#snapshots.values()].some((candidate) => candidate.approvals.some(({ id }) => id === approval.id))) {
      throw new Error(`Approval ${approval.id} already exists`);
    }
    snapshot.approvals.push(structuredClone(approval));
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
    const snapshot = this.#required(campaignId);
    const key = `${campaignId}\u0000${finding.id}`;
    const previousIteration = this.#findingIterations.get(key);
    if (previousIteration !== undefined && iteration < previousIteration) {
      throw new Error(`Stale Qodo finding iteration for ${finding.id}`);
    }
    const index = snapshot.qodoFindings.findIndex(({ id }) => id === finding.id);
    if (index === -1) {
      snapshot.qodoFindings.push(structuredClone(finding));
    } else {
      snapshot.qodoFindings[index] = structuredClone(finding);
    }
    this.#findingIterations.set(key, iteration);
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
    this.#assertEventAvailable(record.attemptedEvent.id);
    if (record.attemptedEvent.eventType !== "external_action_attempted") throw new Error("Invalid external action attempted event");
    assertExternalActionEventVersion(record.attemptedEvent.payload, record.expectedVersion, record.expectedVersion);
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    if ([...this.#snapshots.values()].some((candidate) => candidate.externalActionClaims.some(({ id }) => id === record.claimId))) throw new Error(`External action claim ${record.claimId} already exists`);
    if ([...this.#snapshots.values()].some((candidate) => candidate.externalActionClaims.some(({ approvalId }) => approvalId === record.approvalId))) throw new Error("Approval already has an external action claim");
    const currentCommitSha = singletonCommit(snapshot);
    if (currentCommitSha !== record.expectedCurrentCommitSha) throw new CampaignVersionConflict(campaignId, record.expectedVersion);
    if ((record.payload.action === "create_pr" || record.payload.action === "update_pr") && record.payload.commitSha !== currentCommitSha) throw new Error("External action commit does not match current campaign head");
    if (externalActionDigest(record.payload) !== record.actionDigest) throw new Error("External action payload digest does not match claim");
    const approvalIndex = snapshot.approvals.findIndex(({ id }) => id === record.approvalId);
    const approval = snapshot.approvals[approvalIndex];
    if (approval === undefined || approval.campaignId !== campaignId || approval.action !== record.payload.action || approval.actionDigest !== record.actionDigest) throw new Error("Approval does not match this external action");
    if (!isApprovalActionAllowed(approval.action, snapshot.campaign.status)) throw new Error("Campaign state does not allow this approval action");
    const consumed = consumeDomainApproval(approval, record.actionDigest, record.consumedAt);
    const claim: ExternalActionClaim = {
      id: record.claimId,
      campaignId,
      approvalId: record.approvalId,
      actionDigest: record.actionDigest,
      payload: structuredClone(record.payload),
      ...(currentCommitSha === undefined ? {} : { currentCommitSha }),
      claimedCampaignVersion: record.expectedVersion,
      claimedCampaignStatus: record.expectedStatus,
      status: "active",
      attemptedAt: consumedAt,
      leaseStartedAt,
    };
    snapshot.approvals[approvalIndex] = consumed;
    snapshot.externalActionClaims.push(claim);
    snapshot.events.push(structuredClone(record.attemptedEvent));
    this.#eventIds.add(record.attemptedEvent.id);
    return structuredClone(claim);
  }

  async completeExternalAction(campaignId: string, record: ExternalActionCompletionRecord): Promise<number> {
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
    const resultingVersion = this.#validatedExternalActionHeadVersion(claim, snapshot, record.newCommitSha);
    assertExternalActionEventVersion(record.completedEvent.payload, claim.claimedCampaignVersion, resultingVersion);
    if (record.newCommitSha !== undefined && singletonCommit(snapshot) !== record.newCommitSha) {
      snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit");
      snapshot.externalReferences.push({ kind: "commit", value: record.newCommitSha });
      snapshot.campaign = { ...snapshot.campaign, version: resultingVersion };
    }
    snapshot.events.push(structuredClone(record.completedEvent));
    this.#eventIds.add(record.completedEvent.id);
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
    snapshot.events.push(structuredClone(record.event));
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
    snapshot.events.push(structuredClone(record.event));
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
    const resultingVersion = snapshot.campaign.version + (record.observedCanonicalHead !== undefined && record.observedCanonicalHead !== current ? 1 : 0);
    assertExternalActionEventVersion(record.event.payload, snapshot.campaign.version, resultingVersion);
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("Campaign event persistence failed");
    }
    if (record.observedCanonicalHead !== undefined && record.observedCanonicalHead !== current) {
      snapshot.externalReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit");
      snapshot.externalReferences.push({ kind: "commit", value: record.observedCanonicalHead });
      snapshot.campaign = { ...snapshot.campaign, version: resultingVersion };
    }
    snapshot.events.push(structuredClone(record.event));
    this.#eventIds.add(record.event.id);
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
    if (
      !snapshot.externalReferences.some(
        (candidate) => candidate.kind === reference.kind && candidate.value === reference.value,
      )
    ) {
      snapshot.externalReferences.push(structuredClone(reference));
    }
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
    const nextReferences = snapshot.externalReferences.filter(({ kind }) => kind !== "commit" || record.newCommitSha === undefined);
    if (record.newCommitSha !== undefined) nextReferences.push({ kind: "commit", value: record.newCommitSha });
    for (const kind of ["child_session", "sandbox"] as const) {
      if (!nextReferences.some((reference) => reference.kind === kind && reference.value === record.childSessionId)) nextReferences.push({ kind, value: record.childSessionId });
    }
    snapshot.externalReferences = nextReferences;
    snapshot.events.push(structuredClone(record.event));
    this.#eventIds.add(record.event.id);
    if (resultingVersion !== record.expectedVersion) snapshot.campaign = { ...snapshot.campaign, version: resultingVersion };
    return resultingVersion;
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
}

function cloneSnapshot(snapshot: MutableSnapshot): CampaignSnapshot {
  return structuredClone(snapshot);
}

function assertCommitSha(commitSha: string): void {
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Invalid current commit SHA");
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

function assertExternalActionEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion || !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion) throw new Error("External action event is not bound to the campaign version");
}

function assertStaleRecoveryEvent(event: CampaignEvent, claim: ExternalActionClaim): void {
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
