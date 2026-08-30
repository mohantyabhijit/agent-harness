import {
  isApprovalActionAllowed,
  type ApprovalAction,
} from "../domain/approval.js";
import { transitionCampaign, type Campaign } from "../domain/campaign.js";
import type { Clock, IdGenerator } from "./create-campaign.js";
import type { CampaignEventInput, CampaignSnapshot, CampaignStore, ExternalReference } from "./ports/campaign-store.js";
import type { ExternalActionDisposition } from "./ports/campaign-store.js";
import type {
  CampaignPacket,
  HarnessOperation,
  HarnessPort,
  HarnessSessionResult,
} from "./ports/harness.js";
import { HarnessError } from "./ports/harness.js";
import { ApplicationError } from "./errors.js";
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

export interface ExternalActionReconciliation {
  readonly claimId: string;
  readonly disposition: ExternalActionDisposition;
  readonly observedCanonicalHead?: string;
}

export interface ExternalActionStaleRecovery {
  readonly claimId: string;
  readonly disposition: string;
}

export interface RunCampaignOptions {
  readonly externalActionClaimStaleAfterMs?: number;
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

interface ImplementationResult {
  readonly status: "completed";
  readonly commitSha: string;
  readonly changedAreas: readonly string[];
  readonly tests: readonly string[];
  readonly uncertainty: string;
  readonly before: string;
  readonly after: string;
}

export class RunCampaign {
  readonly #externalActionClaimStaleAfterMs: number;

  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: RunCampaignOptions = {},
  ) {
    const staleAfterMs = options.externalActionClaimStaleAfterMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError("External action claim stale threshold must be a positive integer of milliseconds");
    }
    this.#externalActionClaimStaleAfterMs = staleAfterMs;
  }

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
        throw new ApplicationError("invalid_request");
    }
  }

  async executeApprovedExternalAction<T>(
    campaignId: string,
    request: ExternalActionApproval,
    action: (authorized: Readonly<AuthorizedExternalAction>) => Promise<T>,
    completionReference?: (result: T, authorized: Readonly<AuthorizedExternalAction>) => ExternalReference | undefined,
  ): Promise<T> {
    validateExternalActionPayload(request.payload);
    const snapshot = await this.requiredSnapshot(campaignId);
    if (request.payload.repository !== snapshot.campaign.repository || request.payload.issueNumber !== snapshot.campaign.issueNumber) {
      throw new ApplicationError("campaign_conflict");
    }
    this.assertExternalPayloadReferences(snapshot, request.payload);
    const digest = externalActionDigest(request.payload);
    const approval = snapshot.approvals.find(({ id }) => id === request.approvalId);
    if (approval === undefined || approval.campaignId !== campaignId) {
      throw new ApplicationError("approval_required");
    }
    if (approval.action !== request.payload.action || approval.actionDigest !== digest) {
      throw new ApplicationError("approval_required");
    }
    if (approval.status !== "approved") {
      throw new ApplicationError("approval_required");
    }
    if (!isApprovalActionAllowed(approval.action, snapshot.campaign.status)) {
      throw new ApplicationError("invalid_transition");
    }

    const claimId = this.nextId();
    const claimedAt = canonicalTimestamp(this.clock.now(), "external action claim lease");
    const expectedCurrentCommitSha = campaignCurrentCommit(snapshot);
    const claimed = await this.store.claimExternalAction(campaignId, {
      claimId,
      approvalId: request.approvalId,
      actionDigest: digest,
      payload: structuredClone(request.payload),
      ...(expectedCurrentCommitSha === undefined ? {} : { expectedCurrentCommitSha }),
      expectedVersion: snapshot.campaign.version,
      expectedStatus: snapshot.campaign.status,
      consumedAt: claimedAt,
      leaseStartedAt: claimedAt,
      attemptedEvent: {
        id: this.nextId(),
        eventType: "external_action_attempted",
        payload: externalActionEvidence(claimId, approval.action, approval.actionDigest, snapshot.campaign.version, snapshot.campaign.version, snapshot.campaign.status),
        occurredAt: claimedAt,
      },
    });
    const authorized: Readonly<AuthorizedExternalAction> = deepFreeze({
      campaignId,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      issueUrl: snapshot.campaign.issueUrl,
      action: approval.action,
      actionDigest: approval.actionDigest,
      payload: structuredClone(claimed.payload),
    });

    let result: T;
    let publishedReference: ExternalReference | undefined;
    try {
      result = await action(authorized);
      publishedReference = completionReference?.(result, authorized);
    } catch {
      await this.markOutcomeUnknown(campaignId, claimId, approval.action, approval.actionDigest, snapshot);
      throw new Error("External action outcome is unknown; reconciliation required");
    }

    try {
      const newCommitSha = claimed.payload.action === "push_branch" || claimed.payload.action === "update_pr"
        ? claimed.payload.commitSha
        : undefined;
      const resultingVersion = snapshot.campaign.version + (
        claimed.payload.action === "update_pr" || (newCommitSha !== undefined && newCommitSha !== campaignCurrentCommit(snapshot)) ? 1 : 0
      );
      await this.store.completeExternalAction(campaignId, {
        claimId,
        completedAt: this.clock.now(),
        completedEvent: {
          id: this.nextId(),
          eventType: "external_action_completed",
          payload: externalActionEvidence(claimId, approval.action, approval.actionDigest, snapshot.campaign.version, resultingVersion, snapshot.campaign.status),
          occurredAt: this.clock.now(),
        },
        ...(newCommitSha === undefined ? {} : { newCommitSha }),
        ...(publishedReference === undefined ? {} : { publishedReference }),
      });
    } catch {
      await this.markOutcomeUnknown(campaignId, claimId, approval.action, approval.actionDigest, snapshot);
      throw new Error("External action outcome is unknown; reconciliation required");
    }
    return result;
  }

  async reconcileExternalAction(campaignId: string, input: unknown): Promise<Campaign> {
    const reconciliation = parseExternalActionReconciliation(input);
    const snapshot = await this.requiredSnapshot(campaignId);
    const claim = snapshot.externalActionClaims.find(({ id }) => id === reconciliation.claimId);
    if (claim === undefined || claim.status !== "outcome_unknown") throw new ApplicationError("invalid_transition");
    const current = campaignCurrentCommit(snapshot);
    let confirmedUpdate = false;
    if (reconciliation.disposition === "confirmed_completed" && claim.payload.action === "update_pr") {
      confirmedUpdate = true;
      const updatePayload = claim.payload;
      if (reconciliation.observedCanonicalHead !== updatePayload.commitSha || current !== updatePayload.commitSha || snapshot.campaign.status !== "repair" ||
        !snapshot.externalReferences.some(({ kind, value }) => kind === "pull_request" && value === updatePayload.pullRequest)) {
        throw new ApplicationError("campaign_conflict");
      }
    }
    const preserveVerifiedRepair = reconciliation.disposition === "confirmed_not_completed" && claim.payload.action === "update_pr";
    const resultingVersion = snapshot.campaign.version + (confirmedUpdate || (!preserveVerifiedRepair && reconciliation.observedCanonicalHead !== undefined && reconciliation.observedCanonicalHead !== current) ? 1 : 0);
    await this.store.reconcileExternalAction(campaignId, {
      claimId: reconciliation.claimId,
      disposition: reconciliation.disposition,
      ...(reconciliation.observedCanonicalHead === undefined ? {} : { observedCanonicalHead: reconciliation.observedCanonicalHead }),
      reconciledAt: this.clock.now(),
      event: {
        id: this.nextId(),
        eventType: "external_action_reconciled",
        payload: {
          claimId: reconciliation.claimId,
          action: claim.payload.action,
          actionDigest: claim.actionDigest,
          disposition: reconciliation.disposition,
          ...(reconciliation.observedCanonicalHead === undefined ? {} : { observedCanonicalHead: reconciliation.observedCanonicalHead }),
          claimedCampaignVersion: snapshot.campaign.version,
          resultingCampaignVersion: resultingVersion,
          reason: "human_external_action_reconciliation",
        },
        occurredAt: this.clock.now(),
      },
    });
    return (await this.requiredSnapshot(campaignId)).campaign;
  }

  async recoverStaleExternalAction(campaignId: string, input: unknown): Promise<Campaign> {
    const recovery = parseExternalActionStaleRecovery(input);
    const snapshot = await this.requiredSnapshot(campaignId);
    const claim = snapshot.externalActionClaims.find(({ id }) => id === recovery.claimId);
    if (claim === undefined || claim.status !== "active") throw new ApplicationError("invalid_transition");
    const recoveredAt = canonicalTimestamp(this.clock.now(), "stale claim recovery");
    const staleBefore = new Date(Date.parse(recoveredAt) - this.#externalActionClaimStaleAfterMs).toISOString();
    if (Date.parse(claim.leaseStartedAt) > Date.parse(staleBefore)) {
      throw new ApplicationError("invalid_transition");
    }
    await this.store.recoverStaleExternalActionClaim(campaignId, {
      claimId: recovery.claimId,
      staleBefore,
      recoveredAt,
      operatorDisposition: recovery.disposition,
      event: {
        id: this.nextId(),
        eventType: "external_action_stale_recovered",
        payload: {
          claimId: recovery.claimId,
          action: claim.payload.action,
          actionDigest: claim.actionDigest,
          claimedCampaignVersion: snapshot.campaign.version,
          resultingCampaignVersion: snapshot.campaign.version,
          claimedCampaignStatus: snapshot.campaign.status,
          disposition: "operator_declared_claim_stale",
          reason: "operator_recovered_stale_active_claim",
        },
        occurredAt: recoveredAt,
      },
    });
    return (await this.requiredSnapshot(campaignId)).campaign;
  }

  async recoverInterrupted(campaignId: string): Promise<Campaign> {
    const snapshot = await this.requiredSnapshot(campaignId);
    const fromStatus = snapshot.campaign.status;
    const target = interruptedRecoveryTarget(fromStatus);
    if (target === undefined) throw new ApplicationError("invalid_transition");
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
      throw new ApplicationError("invalid_transition");
    }
    if (
      snapshot.campaign.status !== "coordination_pending" &&
      snapshot.campaign.status !== "quarantined"
    ) {
      throw new ApplicationError("invalid_transition");
    }

    const claimed = transitionCampaign(snapshot.campaign, "preflight");
    await this.store.update(claimed, snapshot.campaign.version);
    try {
      const result = await this.harness.runChildSession(this.packet(snapshot), "preflight");
      let output: PreflightResult;
      try {
        output = parsePreflightResult(result.output);
      } catch {
        const rejectedVersion = await this.store.recordChildResult(claimed.id, {
          expectedVersion: claimed.version,
          expectedStatus: "preflight",
          childSessionId: result.sessionId,
          event: this.operationEvent(claimed, claimed.version, "campaign_operation_rejected", "preflight", result, { reason: "invalid_preflight_output" }),
        });
        await this.failClaimedOperation({ ...claimed, version: rejectedVersion }, "quarantined", "preflight_execution_failed");
        throw new Error("Invalid preflight output");
      }
      const commitChanged = currentCommit(snapshot) !== output.commitSha;
      const resultingVersion = claimed.version + (commitChanged ? 1 : 0);
      const recordedVersion = await this.store.recordChildResult(claimed.id, {
        expectedVersion: claimed.version,
        expectedStatus: "preflight",
        childSessionId: result.sessionId,
        event: this.operationEvent(claimed, resultingVersion, "campaign_operation_completed", "preflight", result, output),
        newCommitSha: output.commitSha,
        operationResult: { operation: "preflight", currentCommitSha: output.commitSha, qodoIteration: claimed.qodoIteration },
      });
      const recorded = { ...claimed, version: recordedVersion };
      const transitioned = transitionCampaign(recorded, output.verdict === "pass" ? "baseline" : "quarantined");
      await this.store.update(transitioned, recorded.version);
      return transitioned;
    } catch (error) {
      await this.failClaimedOperation(claimed, "quarantined", "preflight_execution_failed");
      if (error instanceof HarnessError) throw error;
      throw new Error("Preflight execution failed; campaign quarantined", { cause: error });
    }
  }

  private async runImplementation(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "baseline" && campaign.status !== "verification") {
      throw new ApplicationError("invalid_transition");
    }
    const currentCommitSha = requiredCurrentCommit(snapshot);
    if (campaign.status === "verification" && !hasOperationCompletion(snapshot, "verify", campaign.version, currentCommitSha)) {
      throw new ApplicationError("invalid_transition");
    }
    const claimed = transitionCampaign(campaign, "implementation");
    await this.store.update(claimed, campaign.version);
    try {
      const result = await this.harness.runChildSession(this.packet(snapshot, currentCommitSha), "implement");
      const implementation = parseImplementationResult(result.output, currentCommitSha);
      const resultingCommitSha = implementation.commitSha;
      const resultingVersion = claimed.version + 1;
      const recordedVersion = await this.store.recordChildResult(campaign.id, {
        expectedVersion: claimed.version,
        expectedStatus: "implementation",
        childSessionId: result.sessionId,
        event: this.operationEvent(claimed, resultingVersion, "campaign_operation_completed", "implement", result, { ...implementation, previousCommitSha: currentCommitSha, currentCommitSha: resultingCommitSha }),
        newCommitSha: resultingCommitSha,
        operationResult: { operation: "implement", currentCommitSha: resultingCommitSha, qodoIteration: claimed.qodoIteration },
      });
      return { ...claimed, version: recordedVersion };
    } catch (error) {
      await this.failClaimedOperation(claimed, "human_escalation", "implementation_execution_failed");
      if (error instanceof HarnessError) throw error;
      throw new Error("Implementation execution failed; human reconciliation required", { cause: error });
    }
  }

  private async runVerification(snapshot: CampaignSnapshot): Promise<Campaign> {
    const { campaign } = snapshot;
    if (campaign.status !== "implementation") {
      throw new ApplicationError("invalid_transition");
    }
    const currentCommitSha = requiredCurrentCommit(snapshot);
    if (!hasOperationCompletion(snapshot, "implement", campaign.version, currentCommitSha)) {
      throw new ApplicationError("invalid_transition");
    }

    const claimed = transitionCampaign(campaign, "verification");
    await this.store.update(claimed, campaign.version);
    try {
      const result = await this.harness.runChildSession(this.packet(snapshot, currentCommitSha), "verify");
      parseVerificationResult(result.output, currentCommitSha);
      const recordedVersion = await this.store.recordChildResult(campaign.id, {
        expectedVersion: claimed.version,
        expectedStatus: "verification",
        childSessionId: result.sessionId,
        event: this.operationEvent(claimed, claimed.version, "campaign_operation_completed", "verify", result, { result: result.output, currentCommitSha }),
        operationResult: { operation: "verify", currentCommitSha, qodoIteration: claimed.qodoIteration },
      });
      return { ...claimed, version: recordedVersion };
    } catch (error) {
      await this.failClaimedOperation(claimed, "human_escalation", "verification_execution_failed");
      if (error instanceof HarnessError) throw error;
      throw new Error("Verification execution failed; human reconciliation required", { cause: error });
    }
  }

  private operationEvent(
    claimedCampaign: Campaign,
    resultingCampaignVersion: number,
    eventType: string,
    operation: HarnessOperation,
    result: HarnessSessionResult,
    output: unknown,
  ): CampaignEventInput {
    return {
      id: this.nextId(),
      eventType,
      payload: {
        operation,
        claimedCampaignVersion: claimedCampaign.version,
        resultingCampaignVersion,
        childSessionId: result.sessionId,
        sandboxSessionId: result.sessionId,
        artifacts: result.artifacts,
        summary: result.summary,
        output,
      },
      occurredAt: this.clock.now(),
    };
  }

  private packet(snapshot: CampaignSnapshot, currentCommitSha?: string): CampaignPacket {
    const operationSafety = snapshot.campaign.status === "coordination_pending" || snapshot.campaign.status === "quarantined"
      ? "Static preflight must inspect before any dependency installation or repository script; clone only in this fresh Daytona child."
      : snapshot.campaign.status === "baseline" || snapshot.campaign.status === "verification"
        ? "Clone and work only in this fresh Daytona child; bind output to the current commit and never publish."
        : "Verify the exact current implementation commit in this fresh Daytona child; reject stale results.";
    return {
      campaignId: snapshot.campaign.id,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      goal: `Advance campaign with verified ${snapshot.campaign.status} evidence. ${operationSafety}`,
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
    if (payload.action === "create_pr" && requiredCurrentCommit(snapshot) !== payload.commitSha) throw new Error("External action commit does not match current campaign head");
    if (payload.action === "update_pr") {
      if (requiredCurrentCommit(snapshot) !== payload.commitSha) throw new Error("External action commit does not match current campaign head");
      const pullRequests = snapshot.externalReferences.filter(({ kind }) => kind === "pull_request");
      if (pullRequests.length !== 1 || pullRequests[0]?.value !== payload.pullRequest) throw new Error("External action pull request does not match campaign memory");
    }
  }

  private async markOutcomeUnknown(campaignId: string, claimId: string, action: ApprovalAction, actionDigest: string, snapshot: CampaignSnapshot): Promise<void> {
    try {
      await this.store.markExternalActionOutcomeUnknown(campaignId, {
        claimId,
        event: {
          id: this.nextId(),
          eventType: "external_action_outcome_unknown",
          payload: {
            claimId,
            action,
            actionDigest,
            claimedCampaignVersion: snapshot.campaign.version,
            resultingCampaignVersion: snapshot.campaign.version,
            claimedCampaignStatus: snapshot.campaign.status,
            reason: "external_action_result_unknown",
          },
          occurredAt: this.clock.now(),
        },
      });
    } catch {
      // The durable active claim still blocks mutation and retries if outcome
      // evidence itself cannot be recorded.
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
      throw new ApplicationError("campaign_not_found");
    }
    return snapshot;
  }
}

function interruptedRecoveryTarget(status: Campaign["status"]): "quarantined" | "human_escalation" | undefined {
  if (status === "preflight") return "quarantined";
  if (status === "implementation" || status === "verification" || status === "repair") return "human_escalation";
  return undefined;
}

function hasOperationCompletion(
  snapshot: CampaignSnapshot,
  operation: "implement" | "verify",
  version: number,
  commitSha: string,
): boolean {
  return snapshot.events.some((event) => {
    if (event.eventType !== "campaign_operation_completed" || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.operation === operation && event.payload.resultingCampaignVersion === version &&
      isRecord(event.payload.output) && event.payload.output.currentCommitSha === commitSha;
  });
}

function currentCommit(snapshot: CampaignSnapshot): string | undefined {
  return snapshot.externalReferences.find(({ kind }) => kind === "commit")?.value;
}

function campaignCurrentCommit(snapshot: CampaignSnapshot): string | undefined {
  const commits = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
  if (commits.length > 1) throw new Error("Campaign current commit is ambiguous");
  return commits[0]?.value;
}

function externalActionEvidence(
  claimId: string,
  action: ApprovalAction,
  actionDigest: string,
  claimedCampaignVersion: number,
  resultingCampaignVersion: number,
  claimedCampaignStatus: Campaign["status"],
): Readonly<Record<string, unknown>> {
  return {
    claimId,
    action,
    actionDigest,
    claimedCampaignVersion,
    resultingCampaignVersion,
    claimedCampaignStatus,
  };
}

function parseExternalActionReconciliation(input: unknown): ExternalActionReconciliation {
  if (!isRecord(input)) throw new Error("Invalid external action reconciliation");
  const keys = Object.keys(input);
  if (
    keys.some((key) => !["claimId", "disposition", "observedCanonicalHead"].includes(key)) ||
    typeof input.claimId !== "string" || input.claimId.trim().length === 0 ||
    (input.disposition !== "confirmed_completed" && input.disposition !== "confirmed_not_completed") ||
    (input.observedCanonicalHead !== undefined && (typeof input.observedCanonicalHead !== "string" || !/^[0-9a-f]{40}$/u.test(input.observedCanonicalHead)))
  ) throw new Error("Invalid external action reconciliation");
  return {
    claimId: input.claimId,
    disposition: input.disposition,
    ...(input.observedCanonicalHead === undefined ? {} : { observedCanonicalHead: input.observedCanonicalHead }),
  };
}

function parseExternalActionStaleRecovery(input: unknown): ExternalActionStaleRecovery {
  if (!isRecord(input) || Object.keys(input).some((key) => !["claimId", "disposition"].includes(key)) ||
    typeof input.claimId !== "string" || input.claimId.trim().length === 0 ||
    typeof input.disposition !== "string" || input.disposition.trim().length === 0) {
    throw new Error("Invalid stale external action recovery disposition");
  }
  return { claimId: input.claimId, disposition: input.disposition.trim() };
}

function canonicalTimestamp(value: string, label: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new TypeError(`Invalid ${label} timestamp`);
  return new Date(instant).toISOString();
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

function parseImplementationResult(output: unknown, currentCommitSha: string): ImplementationResult {
  if (!isRecord(output) || Object.keys(output).some((key) => !["status", "commitSha", "changedAreas", "tests", "uncertainty", "before", "after"].includes(key)) ||
    output.status !== "completed" || typeof output.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(output.commitSha) ||
    output.commitSha === currentCommitSha || !stringList(output.changedAreas) || !stringList(output.tests) ||
    typeof output.uncertainty !== "string" || output.uncertainty.trim().length === 0 ||
    typeof output.before !== "string" || output.before.trim().length === 0 || typeof output.after !== "string" || output.after.trim().length === 0) {
    throw new Error("Invalid implementation result");
  }
  return { status: "completed", commitSha: output.commitSha, changedAreas: output.changedAreas, tests: output.tests, uncertainty: output.uncertainty, before: output.before, after: output.after };
}

function parseVerificationResult(output: unknown, currentCommitSha: string): void {
  if (!isRecord(output) || Object.keys(output).some((key) => !["testsPassed", "currentCommitSha", "tests", "uncertainty"].includes(key)) ||
    output.testsPassed !== true || output.currentCommitSha !== currentCommitSha || !stringList(output.tests) ||
    typeof output.uncertainty !== "string" || output.uncertainty.trim().length === 0) throw new Error("Invalid verification result");
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
