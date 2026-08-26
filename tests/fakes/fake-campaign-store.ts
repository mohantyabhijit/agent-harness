import {
  CampaignIdentityConflict,
  CampaignVersionConflict,
  type CampaignEvent,
  type CampaignSnapshot,
  type CampaignStore,
  type ExternalReference,
} from "../../src/application/ports/campaign-store.js";
import { consumeApproval as consumeDomainApproval, type Approval } from "../../src/domain/approval.js";
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
  createBarrier?: () => Promise<void>;

  seed(campaign: Campaign): void {
    this.#insert(campaign);
  }

  async create(campaign: Campaign): Promise<void> {
    await this.createBarrier?.();
    this.#insert(campaign);
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
    const snapshot = this.#required(campaignId);
    if (snapshot.events.some((candidate) => candidate.id === event.id)) {
      throw new Error(`Campaign event ${event.id} already exists`);
    }
    snapshot.events.push(structuredClone(event));
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
  ): Promise<Approval> {
    for (const snapshot of this.#snapshots.values()) {
      const index = snapshot.approvals.findIndex((approval) => approval.id === approvalId);
      if (index !== -1) {
        const approval = snapshot.approvals[index];
        if (approval === undefined) {
          break;
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
    const snapshot = this.#required(campaignId);
    if (
      !snapshot.externalReferences.some(
        (candidate) => candidate.kind === reference.kind && candidate.value === reference.value,
      )
    ) {
      snapshot.externalReferences.push(structuredClone(reference));
    }
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
}

function cloneSnapshot(snapshot: MutableSnapshot): CampaignSnapshot {
  return structuredClone(snapshot);
}
