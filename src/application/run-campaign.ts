import type { ApprovalAction } from "../domain/approval.js";
import { transitionCampaign, type Campaign } from "../domain/campaign.js";
import type { Clock, IdGenerator } from "./create-campaign.js";
import type { CampaignSnapshot, CampaignStore } from "./ports/campaign-store.js";
import type {
  CampaignPacket,
  HarnessOperation,
  HarnessPort,
  HarnessSessionResult,
} from "./ports/harness.js";

export type CampaignOperation = "preflight" | "implement" | "verify";

export interface ExternalActionApproval {
  readonly approvalId: string;
  readonly action: ApprovalAction;
  readonly actionDigest: string;
}

interface PreflightResult {
  readonly verdict: "pass" | "quarantine";
  readonly checks: readonly string[];
  readonly commitSha: string;
}

export class RunCampaign {
  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(campaignId: string, operation: CampaignOperation): Promise<Campaign> {
    const snapshot = await this.requiredSnapshot(campaignId);
    switch (operation) {
      case "preflight":
        return this.runPreflight(snapshot);
      case "implement":
        return this.runImplementation(snapshot);
      case "verify":
        return this.runVerification(snapshot);
      default:
        throw new Error("Unknown campaign operation");
    }
  }

  async executeApprovedExternalAction<T>(
    campaignId: string,
    request: ExternalActionApproval,
    action: () => Promise<T>,
  ): Promise<T> {
    const snapshot = await this.requiredSnapshot(campaignId);
    const approval = snapshot.approvals.find(({ id }) => id === request.approvalId);
    if (approval === undefined || approval.campaignId !== campaignId) {
      throw new Error("Approval does not exist for this campaign");
    }
    if (approval.action !== request.action || approval.actionDigest !== request.actionDigest) {
      throw new Error("Approval does not match this external action");
    }
    if (approval.status !== "approved") {
      throw new Error("Approval is not available");
    }

    // The durable store performs the compare-and-consume atomically. Keep this
    // call directly adjacent to the injected write so stale or replayed approval
    // can never cross the orchestration boundary.
    await this.store.consumeApproval(request.approvalId, request.actionDigest, this.clock.now());
    const result = await action();
    await this.store.appendEvent(campaignId, {
      id: this.nextId(),
      eventType: "external_action_completed",
      payload: { action: request.action, actionDigest: request.actionDigest },
      occurredAt: this.clock.now(),
    });
    return result;
  }

  async runPreflight(snapshot: CampaignSnapshot): Promise<Campaign> {
    let active = snapshot.campaign;
    if (active.status !== "preflight") {
      if (
        active.status !== "policy_review" &&
        active.status !== "coordination_pending" &&
        active.status !== "quarantined"
      ) {
        throw new Error("Campaign cannot run preflight from its current state");
      }
      active = transitionCampaign(active, "preflight");
      await this.store.update(active, snapshot.campaign.version);
    }

    const result = await this.harness.runChildSession(this.packet(snapshot), "preflight");
    await this.recordSessionReferences(active.id, result);
    let output: PreflightResult;
    try {
      output = parsePreflightResult(result.output);
    } catch {
      await this.appendOperationEvent(active.id, "campaign_operation_rejected", "preflight", result, {
        reason: "invalid_preflight_output",
      });
      throw new Error("Invalid preflight output");
    }
    await this.appendOperationEvent(
      active.id,
      "campaign_operation_completed",
      "preflight",
      result,
      output,
    );
    const transitioned = transitionCampaign(active, output.verdict === "pass" ? "baseline" : "quarantined");
    await this.store.update(transitioned, active.version);
    return transitioned;
  }

  async runImplementation(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "baseline" && campaign.status !== "verification") {
      throw new Error("Campaign must pass preflight before implementation");
    }
    const transitioned = transitionCampaign(campaign, "implementation");
    await this.store.update(transitioned, campaign.version);
    const result = await this.harness.runChildSession(this.packet(snapshot), "implement");
    await this.recordSession(campaign.id, "implement", result, result.output);
    return transitioned;
  }

  async runVerification(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "implementation") {
      const reason = campaign.status === "quarantined" || campaign.status === "policy_review"
        ? "Campaign must pass preflight before verification"
        : "Campaign must be implemented before verification";
      throw new Error(reason);
    }
    const transitioned = transitionCampaign(campaign, "verification");
    await this.store.update(transitioned, campaign.version);
    const result = await this.harness.runChildSession(this.packet(snapshot), "verify");
    await this.recordSession(campaign.id, "verify", result, result.output);
    return transitioned;
  }

  async recordSession(
    campaignId: string,
    operation: HarnessOperation,
    result: HarnessSessionResult,
    output: unknown,
  ): Promise<void> {
    await this.recordSessionReferences(campaignId, result);
    await this.appendOperationEvent(
      campaignId,
      "campaign_operation_completed",
      operation,
      result,
      output,
    );
  }

  async recordSessionReferences(campaignId: string, result: HarnessSessionResult): Promise<void> {
    await this.store.setExternalReference(campaignId, {
      kind: "child_session",
      value: result.sessionId,
    });
    for (const artifact of result.artifacts) {
      await this.store.setExternalReference(campaignId, { kind: "sandbox", value: artifact });
    }
  }

  async appendOperationEvent(
    campaignId: string,
    eventType: string,
    operation: HarnessOperation,
    result: HarnessSessionResult,
    output: unknown,
  ): Promise<void> {
    await this.store.appendEvent(campaignId, {
      id: this.nextId(),
      eventType,
      payload: {
        operation,
        childSessionId: result.sessionId,
        artifacts: result.artifacts,
        summary: result.summary,
        output,
      },
      occurredAt: this.clock.now(),
    });
  }

  packet(snapshot: CampaignSnapshot): CampaignPacket {
    return {
      campaignId: snapshot.campaign.id,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      goal: `Advance campaign with verified ${snapshot.campaign.status} evidence`,
      verifiedEvidence: snapshot.evidence
        .filter(({ kind }) => kind === "direct")
        .map(({ sourceUrl, observation }) => ({ sourceUrl, observation })),
      approvals: snapshot.approvals.map(({ action, actionDigest, status }) => ({
        action,
        digest: actionDigest,
        status,
      })),
    };
  }

  nextId(): string {
    const id = this.ids.next();
    if (id.trim().length === 0) {
      throw new Error("Invalid campaign event identifier");
    }
    return id;
  }

  private async requiredSnapshot(campaignId: string): Promise<CampaignSnapshot> {
    const snapshot = await this.store.get(campaignId);
    if (snapshot === undefined) {
      throw new Error("Campaign does not exist");
    }
    return snapshot;
  }
}

function parsePreflightResult(output: unknown): PreflightResult {
  if (typeof output !== "object" || output === null) {
    throw new Error("Invalid preflight output");
  }
  const value = output as Record<string, unknown>;
  if (
    (value.verdict !== "pass" && value.verdict !== "quarantine") ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0 ||
    value.checks.some((check) => typeof check !== "string" || check.trim().length === 0) ||
    typeof value.commitSha !== "string" ||
    value.commitSha.trim().length === 0
  ) {
    throw new Error("Invalid preflight output");
  }
  return {
    verdict: value.verdict,
    checks: value.checks as string[],
    commitSha: value.commitSha,
  };
}
