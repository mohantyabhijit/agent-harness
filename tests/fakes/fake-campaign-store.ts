import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  type CampaignEvent,
  type ChildResultRecord,
  type CampaignSnapshot,
  type CampaignStore,
  type ExternalReference,
} from "../../src/application/ports/campaign-store.js";
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

function assertChildEventVersion(payload: unknown, expectedVersion: number, resultingVersion: number): void {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    !("claimedCampaignVersion" in payload) || payload.claimedCampaignVersion !== expectedVersion ||
    !("resultingCampaignVersion" in payload) || payload.resultingCampaignVersion !== resultingVersion
  ) throw new Error("Child result event is not bound to the campaign version");
}
