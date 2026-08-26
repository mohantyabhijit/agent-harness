import {
  isApprovalActionAllowed,
  type ApprovalAction,
} from "../domain/approval.js";
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

export interface AuthorizedExternalAction {
  readonly campaignId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly action: ApprovalAction;
  readonly actionDigest: string;
}

export const requiredPreflightChecks = [
  "manifest_and_lifecycle_scripts",
  "suspicious_paths",
  "credential_and_secret_boundary",
  "network_behavior",
  "repository_metadata",
] as const;

interface PreflightResult {
  readonly verdict: "pass" | "quarantine";
  readonly checks: typeof requiredPreflightChecks;
  readonly commitSha: string;
  readonly dependenciesInstalled: false;
  readonly repositoryScriptsExecuted: false;
  readonly quarantineReason?: string;
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
    action: (authorized: Readonly<AuthorizedExternalAction>) => Promise<T>,
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
    if (!isApprovalActionAllowed(approval.action, snapshot.campaign.status)) {
      throw new Error("Campaign state does not allow this external action");
    }

    const authorized: Readonly<AuthorizedExternalAction> = Object.freeze({
      campaignId,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      issueUrl: snapshot.campaign.issueUrl,
      action: approval.action,
      actionDigest: approval.actionDigest,
    });
    await this.store.consumeApproval(
      request.approvalId,
      request.actionDigest,
      this.clock.now(),
      snapshot.campaign.version,
      snapshot.campaign.status,
    );
    try {
      await this.appendExternalEvent(snapshot, "external_action_attempted", authorized);
    } catch {
      throw new Error("External action was not attempted; consumed approval reconciliation required");
    }

    let result: T;
    try {
      result = await action(authorized);
    } catch {
      await this.appendOutcomeUnknown(snapshot, authorized);
      throw new Error("External action outcome is unknown; reconciliation required");
    }

    try {
      await this.appendExternalEvent(snapshot, "external_action_completed", authorized);
    } catch {
      await this.appendOutcomeUnknown(snapshot, authorized);
      throw new Error("External action outcome is unknown; reconciliation required");
    }
    return result;
  }

  private async runPreflight(snapshot: CampaignSnapshot): Promise<Campaign> {
    if (snapshot.campaign.status === "preflight") {
      throw new Error("Campaign preflight requires explicit human recovery");
    }
    if (
      snapshot.campaign.status !== "policy_review" &&
      snapshot.campaign.status !== "coordination_pending" &&
      snapshot.campaign.status !== "quarantined"
    ) {
      throw new Error("Campaign cannot run preflight from its current state");
    }

    const claimed = transitionCampaign(snapshot.campaign, "preflight");
    await this.store.update(claimed, snapshot.campaign.version);
    const result = await this.harness.runChildSession(this.packet(snapshot), "preflight");
    await this.recordSessionReferences(claimed.id, result);

    let output: PreflightResult;
    try {
      output = parsePreflightResult(result.output);
    } catch {
      await this.appendOperationEvent(
        claimed,
        "campaign_operation_rejected",
        "preflight",
        result,
        { reason: "invalid_preflight_output" },
      );
      throw new Error("Invalid preflight output");
    }
    await this.appendOperationEvent(
      claimed,
      "campaign_operation_completed",
      "preflight",
      result,
      output,
    );
    const transitioned = transitionCampaign(
      claimed,
      output.verdict === "pass" ? "baseline" : "quarantined",
    );
    await this.store.update(transitioned, claimed.version);
    return transitioned;
  }

  private async runImplementation(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "baseline" && campaign.status !== "verification") {
      throw new Error("Campaign must pass preflight before implementation");
    }
    const claimed = transitionCampaign(campaign, "implementation");
    await this.store.update(claimed, campaign.version);
    const result = await this.harness.runChildSession(this.packet(snapshot), "implement");
    await this.recordSessionReferences(campaign.id, result);
    await this.appendOperationEvent(
      claimed,
      "campaign_operation_completed",
      "implement",
      result,
      result.output,
    );
    return claimed;
  }

  private async runVerification(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "implementation") {
      const reason = campaign.status === "quarantined" || campaign.status === "policy_review"
        ? "Campaign must pass preflight before verification"
        : "Campaign must be implemented before verification";
      throw new Error(reason);
    }
    if (!hasImplementationCompletion(snapshot, campaign.version)) {
      throw new Error("Campaign lacks an implementation completion event for this version");
    }

    const claimed = transitionCampaign(campaign, "verification");
    await this.store.update(claimed, campaign.version);
    const result = await this.harness.runChildSession(this.packet(snapshot), "verify");
    await this.recordSessionReferences(campaign.id, result);
    await this.appendOperationEvent(
      claimed,
      "campaign_operation_completed",
      "verify",
      result,
      result.output,
    );
    return claimed;
  }

  private async recordSessionReferences(
    campaignId: string,
    result: HarnessSessionResult,
  ): Promise<void> {
    await this.store.setExternalReference(campaignId, {
      kind: "child_session",
      value: result.sessionId,
    });
    await this.store.setExternalReference(campaignId, {
      kind: "sandbox",
      value: result.sessionId,
    });
  }

  private async appendOperationEvent(
    claimedCampaign: Campaign,
    eventType: string,
    operation: HarnessOperation,
    result: HarnessSessionResult,
    output: unknown,
  ): Promise<void> {
    await this.store.appendEvent(claimedCampaign.id, {
      id: this.nextId(),
      eventType,
      payload: {
        operation,
        claimedCampaignVersion: claimedCampaign.version,
        childSessionId: result.sessionId,
        sandboxSessionId: result.sessionId,
        artifacts: result.artifacts,
        summary: result.summary,
        output,
      },
      occurredAt: this.clock.now(),
    });
  }

  private packet(snapshot: CampaignSnapshot): CampaignPacket {
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

  private async appendExternalEvent(
    snapshot: CampaignSnapshot,
    eventType: string,
    authorized: Readonly<AuthorizedExternalAction>,
  ): Promise<void> {
    await this.store.appendEvent(snapshot.campaign.id, {
      id: this.nextId(),
      eventType,
      payload: {
        authorized,
        claimedCampaignVersion: snapshot.campaign.version,
        claimedCampaignStatus: snapshot.campaign.status,
      },
      occurredAt: this.clock.now(),
    });
  }

  private async appendOutcomeUnknown(
    snapshot: CampaignSnapshot,
    authorized: Readonly<AuthorizedExternalAction>,
  ): Promise<void> {
    try {
      await this.store.appendEvent(snapshot.campaign.id, {
        id: this.nextId(),
        eventType: "external_action_outcome_unknown",
        payload: {
          authorized,
          claimedCampaignVersion: snapshot.campaign.version,
          claimedCampaignStatus: snapshot.campaign.status,
          reason: "external_action_result_unknown",
        },
        occurredAt: this.clock.now(),
      });
    } catch {
      // The approval remains consumed. Never retry an external action merely
      // because durable outcome evidence also failed to persist.
    }
  }

  private nextId(): string {
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

function hasImplementationCompletion(snapshot: CampaignSnapshot, version: number): boolean {
  return snapshot.events.some((event) => {
    if (event.eventType !== "campaign_operation_completed" || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.operation === "implement" && event.payload.claimedCampaignVersion === version;
  });
}

function parsePreflightResult(output: unknown): PreflightResult {
  if (!isRecord(output)) {
    throw new Error("Invalid preflight output");
  }
  const allowedKeys = new Set([
    "verdict",
    "checks",
    "commitSha",
    "dependenciesInstalled",
    "repositoryScriptsExecuted",
    "quarantineReason",
  ]);
  if (Object.keys(output).some((key) => !allowedKeys.has(key))) {
    throw new Error("Invalid preflight output");
  }
  if (
    (output.verdict !== "pass" && output.verdict !== "quarantine") ||
    !Array.isArray(output.checks) ||
    output.checks.length !== requiredPreflightChecks.length ||
    new Set(output.checks).size !== requiredPreflightChecks.length ||
    output.checks.some((check) =>
      typeof check !== "string" ||
      !(requiredPreflightChecks as readonly string[]).includes(check)
    ) ||
    typeof output.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(output.commitSha) ||
    output.dependenciesInstalled !== false ||
    output.repositoryScriptsExecuted !== false
  ) {
    throw new Error("Invalid preflight output");
  }
  if (
    (output.verdict === "pass" && "quarantineReason" in output) ||
    (output.verdict === "quarantine" &&
      (typeof output.quarantineReason !== "string" || output.quarantineReason.trim().length === 0))
  ) {
    throw new Error("Invalid preflight output");
  }
  return {
    verdict: output.verdict,
    checks: [...requiredPreflightChecks],
    commitSha: output.commitSha,
    dependenciesInstalled: false,
    repositoryScriptsExecuted: false,
    ...(output.verdict === "quarantine" ? { quarantineReason: output.quarantineReason as string } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
