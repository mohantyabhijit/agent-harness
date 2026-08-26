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
import {
  deepFreeze,
  externalActionDigest,
  validateExternalActionPayload,
  type ExternalActionPayload,
} from "./external-action.js";

export type CampaignOperation = "preflight" | "implement" | "verify";

export interface ExternalActionApproval {
  readonly approvalId: string;
  readonly payload: ExternalActionPayload;
}

export interface AuthorizedExternalAction {
  readonly campaignId: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly action: ApprovalAction;
  readonly actionDigest: string;
  readonly payload: ExternalActionPayload;
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
  readonly evidence: readonly PreflightEvidence[];
  readonly quarantineReason?: string;
}

interface PreflightEvidence {
  readonly check: (typeof requiredPreflightChecks)[number];
  readonly sourceUrl: string;
  readonly observation: string;
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
    validateExternalActionPayload(request.payload);
    const snapshot = await this.requiredSnapshot(campaignId);
    if (request.payload.repository !== snapshot.campaign.repository || request.payload.issueNumber !== snapshot.campaign.issueNumber) {
      throw new Error("External action payload does not match campaign identity");
    }
    this.assertExternalPayloadReferences(snapshot, request.payload);
    const digest = externalActionDigest(request.payload);
    const approval = snapshot.approvals.find(({ id }) => id === request.approvalId);
    if (approval === undefined || approval.campaignId !== campaignId) {
      throw new Error("Approval does not exist for this campaign");
    }
    if (approval.action !== request.payload.action || approval.actionDigest !== digest) {
      throw new Error("Approval does not match this external action");
    }
    if (approval.status !== "approved") {
      throw new Error("Approval is not available");
    }
    if (!isApprovalActionAllowed(approval.action, snapshot.campaign.status)) {
      throw new Error("Campaign state does not allow this external action");
    }

    const authorized: Readonly<AuthorizedExternalAction> = deepFreeze({
      campaignId,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      issueUrl: snapshot.campaign.issueUrl,
      action: approval.action,
      actionDigest: approval.actionDigest,
      payload: structuredClone(request.payload),
    });
    await this.store.consumeApproval(
      request.approvalId,
      digest,
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

  async recoverInterrupted(campaignId: string): Promise<Campaign> {
    const snapshot = await this.requiredSnapshot(campaignId);
    const fromStatus = snapshot.campaign.status;
    const target = interruptedRecoveryTarget(fromStatus);
    if (target === undefined) throw new Error("Campaign has no interrupted operation to recover");
    const recovered = transitionCampaign(snapshot.campaign, target);
    await this.store.update(recovered, snapshot.campaign.version);
    await this.store.appendEvent(campaignId, {
      id: this.nextId(), eventType: "interrupted_operation_recovered",
      payload: { fromStatus, targetStatus: target, claimedCampaignVersion: recovered.version, reason: "operator_recovered_interrupted_operation" },
      occurredAt: this.clock.now(),
    });
    return recovered;
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
    try {
      const result = await this.harness.runChildSession(this.packet(snapshot), "preflight");
      await this.recordSessionReferences(claimed.id, result);
      const output = parsePreflightResult(result.output);
      await this.store.setExternalReference(claimed.id, { kind: "commit", value: output.commitSha });
      await this.appendOperationEvent(claimed, "preflight_commit_bound", "preflight", result, output);
      await this.appendOperationEvent(claimed, "campaign_operation_completed", "preflight", result, output);
      const transitioned = transitionCampaign(claimed, output.verdict === "pass" ? "baseline" : "quarantined");
      await this.store.update(transitioned, claimed.version);
      return transitioned;
    } catch {
      await this.failClaimedOperation(claimed, "quarantined", "preflight_execution_failed");
      throw new Error("Preflight execution failed; campaign quarantined");
    }
  }

  private async runImplementation(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "baseline" && campaign.status !== "verification") {
      throw new Error("Campaign must pass preflight before implementation");
    }
    const claimed = transitionCampaign(campaign, "implementation");
    await this.store.update(claimed, campaign.version);
    try {
      const currentCommitSha = requiredCurrentCommit(snapshot);
      const result = await this.harness.runChildSession(this.packet(snapshot, currentCommitSha), "implement");
      await this.recordSessionReferences(campaign.id, result);
      const nextCommitSha = implementationCommit(result.output);
      if (nextCommitSha !== undefined && nextCommitSha !== currentCommitSha) {
        await this.store.setExternalReference(campaign.id, { kind: "commit", value: nextCommitSha });
        await this.appendOperationEvent(claimed, "campaign_commit_updated", "implement", result, { previousCommitSha: currentCommitSha, commitSha: nextCommitSha });
      }
      await this.appendOperationEvent(claimed, "campaign_operation_completed", "implement", result, { result: result.output, currentCommitSha: nextCommitSha ?? currentCommitSha });
      return claimed;
    } catch {
      await this.failClaimedOperation(claimed, "human_escalation", "implementation_execution_failed");
      throw new Error("Implementation execution failed; human reconciliation required");
    }
  }

  private async runVerification(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "implementation") {
      const reason = campaign.status === "quarantined" || campaign.status === "policy_review"
        ? "Campaign must pass preflight before verification"
        : "Campaign must be implemented before verification";
      throw new Error(reason);
    }
    const currentCommitSha = requiredCurrentCommit(snapshot);
    if (!hasImplementationCompletion(snapshot, campaign.version, currentCommitSha)) {
      throw new Error("Campaign lacks an implementation completion event for this version");
    }

    const claimed = transitionCampaign(campaign, "verification");
    await this.store.update(claimed, campaign.version);
    try {
      const result = await this.harness.runChildSession(this.packet(snapshot, currentCommitSha), "verify");
      await this.recordSessionReferences(campaign.id, result);
      await this.appendOperationEvent(claimed, "campaign_operation_completed", "verify", result, { result: result.output, currentCommitSha });
      return claimed;
    } catch {
      await this.failClaimedOperation(claimed, "human_escalation", "verification_execution_failed");
      throw new Error("Verification execution failed; human reconciliation required");
    }
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

  private packet(snapshot: CampaignSnapshot, currentCommitSha?: string): CampaignPacket {
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
      ...(currentCommitSha === undefined ? {} : { currentCommitSha }),
    };
  }

  private async failClaimedOperation(claimed: Campaign, target: "quarantined" | "human_escalation", eventType: string): Promise<void> {
    try {
      const failed = transitionCampaign(claimed, target);
      await this.store.update(failed, claimed.version);
      await this.store.appendEvent(claimed.id, { id: this.nextId(), eventType, payload: { reason: "operation_result_not_safely_recorded", claimedCampaignVersion: claimed.version }, occurredAt: this.clock.now() });
    } catch { /* fail closed: the original claimed state remains non-dispatchable */ }
  }

  private assertExternalPayloadReferences(snapshot: CampaignSnapshot, payload: ExternalActionPayload): void {
    if ("commitSha" in payload && requiredCurrentCommit(snapshot) !== payload.commitSha) throw new Error("External action commit does not match current campaign head");
    if (payload.action === "update_pr" && !snapshot.externalReferences.some(({ kind, value }) => kind === "pull_request" && value === payload.pullRequest)) throw new Error("External action pull request does not match campaign memory");
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

function interruptedRecoveryTarget(status: Campaign["status"]): "quarantined" | "human_escalation" | undefined {
  if (status === "preflight") return "quarantined";
  if (status === "implementation" || status === "verification" || status === "repair") return "human_escalation";
  return undefined;
}

function hasImplementationCompletion(snapshot: CampaignSnapshot, version: number, commitSha: string): boolean {
  return snapshot.events.some((event) => {
    if (event.eventType !== "campaign_operation_completed" || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.operation === "implement" && event.payload.claimedCampaignVersion === version &&
      isRecord(event.payload.output) && event.payload.output.currentCommitSha === commitSha;
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
    "evidence",
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
  if (!Array.isArray(output.evidence) || output.evidence.length !== requiredPreflightChecks.length) throw new Error("Invalid preflight output");
  const evidence = output.evidence.map(parsePreflightEvidence);
  if (new Set(evidence.map(({ check }) => check)).size !== requiredPreflightChecks.length || requiredPreflightChecks.some((check) => !evidence.some((item) => item.check === check))) throw new Error("Invalid preflight output");
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
    evidence,
    ...(output.verdict === "quarantine" ? { quarantineReason: output.quarantineReason as string } : {}),
  };
}

function parsePreflightEvidence(value: unknown): PreflightEvidence {
  if (!isRecord(value) || Object.keys(value).some((key) => !["check", "sourceUrl", "observation"].includes(key)) ||
    typeof value.check !== "string" || !(requiredPreflightChecks as readonly string[]).includes(value.check) ||
    typeof value.sourceUrl !== "string" || !/^https?:\/\/\S+$/u.test(value.sourceUrl) ||
    typeof value.observation !== "string" || value.observation.trim().length === 0) throw new Error("Invalid preflight evidence");
  return { check: value.check as PreflightEvidence["check"], sourceUrl: value.sourceUrl, observation: value.observation };
}

function requiredCurrentCommit(snapshot: CampaignSnapshot): string {
  const commits = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
  const current = commits[0];
  if (commits.length !== 1 || current === undefined || !/^[0-9a-f]{40}$/u.test(current.value)) throw new Error("Campaign current commit is unavailable");
  return current.value;
}

function implementationCommit(output: unknown): string | undefined {
  if (!isRecord(output) || output.commitSha === undefined) return undefined;
  if (typeof output.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(output.commitSha)) throw new Error("Invalid implementation commit");
  return output.commitSha;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
