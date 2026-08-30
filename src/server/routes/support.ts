import { z } from "zod";

import { currentApprovalProposal, proposalActionSummary } from "../../application/approval-proposal.js";
import type { CampaignSnapshot } from "../../application/ports/campaign-store.js";
import type { Approval } from "../../domain/approval.js";

export const campaignIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
export const repositoryPartSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u);
export const repositorySchema = z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
export const issueNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const boundedUrlSchema = z.url().max(2_048);

export class ApiProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ApiProblem";
  }
}

export function campaignNotFound(): ApiProblem {
  return new ApiProblem(404, "campaign_not_found", "Campaign was not found");
}

export function publicCampaignSnapshot(snapshot: CampaignSnapshot, now: number): Readonly<Record<string, unknown>> {
  if (!Number.isFinite(now)) throw new Error("Campaign projection clock is invalid");
  assertValidEventSequence(snapshot);
  const proposal = currentApprovalProposal(snapshot);
  return {
    ...snapshot.campaign,
    nextAllowedAction: nextAllowedAction(snapshot),
    evidence: snapshot.evidence,
    events: snapshot.events.filter(({ eventType, sequence }) => publicEventTypes.has(eventType) && typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0).map(({ id, eventType, occurredAt, sequence, payload }) => ({ id, eventType, occurredAt, sequence, facts: safeEventFacts(eventType, payload) })),
    approvals: snapshot.approvals.map((approval) => publicApprovalWithProposal(approval, proposal, now)),
    qodoFindings: snapshot.qodoFindings.map(safePublicQodoFinding),
    externalReferences: snapshot.externalReferences.filter(({ value }) => value.length <= 2_048),
    externalActionClaims: snapshot.externalActionClaims.map((claim) => ({
      id: claim.id,
      approvalId: claim.approvalId,
      action: claim.payload.action,
      actionDigest: claim.actionDigest,
      claimedCampaignVersion: claim.claimedCampaignVersion,
      claimedCampaignStatus: claim.claimedCampaignStatus,
      status: claim.status,
      attemptedAt: claim.attemptedAt,
      leaseStartedAt: claim.leaseStartedAt,
      ...(claim.closedAt === undefined ? {} : { closedAt: claim.closedAt }),
      ...(claim.disposition === undefined ? {} : { disposition: claim.disposition }),
    })),
    approvalProposal: proposal === null ? null : publicApprovalProposal(proposal),
    qualityEscalationReason: qualityEscalationReason(snapshot),
  };
}

function nextAllowedAction(snapshot: CampaignSnapshot): "preflight" | "implement" | "verify" | null {
  switch (snapshot.campaign.status) {
    case "policy_review":
    case "coordination_pending":
    case "quarantined":
      return "preflight";
    case "baseline":
      return "implement";
    case "implementation":
      return hasCompletedOperation(snapshot, "implement") ? "verify" : null;
    case "verification":
      return hasCompletedOperation(snapshot, "verify") ? "implement" : null;
    default:
      return null;
  }
}

function hasCompletedOperation(snapshot: CampaignSnapshot, operation: "implement" | "verify"): boolean {
  const commitSha = snapshot.externalReferences.find(({ kind }) => kind === "commit")?.value;
  if (commitSha === undefined) return false;
  return snapshot.events.some((event) => {
    if (event.eventType !== "campaign_operation_completed" || !isRecord(event.payload) || event.payload.operation !== operation || event.payload.resultingCampaignVersion !== snapshot.campaign.version || !isRecord(event.payload.output)) return false;
    return event.payload.output.currentCommitSha === commitSha;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePublicQodoFinding(finding: CampaignSnapshot["qodoFindings"][number]): Readonly<Record<string, unknown>> {
  return {
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    summary: finding.summary,
    ...(finding.sourceUrl !== undefined && validQodoUrl(finding.sourceUrl) ? { sourceUrl: finding.sourceUrl } : {}),
    ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
  };
}

export function publicApproval(snapshot: CampaignSnapshot, approval: Approval, now: number): Readonly<Record<string, unknown>> {
  if (!Number.isFinite(now)) throw new Error("Approval projection clock is invalid");
  return publicApprovalWithProposal(approval, currentApprovalProposal(snapshot), now);
}

function publicApprovalWithProposal(approval: Approval, proposal: ReturnType<typeof currentApprovalProposal>, now: number): Readonly<Record<string, unknown>> {
  const isActive = approval.status === "approved" && approval.active === true && approval.trustedProposalAuthority === true &&
    proposal !== null && approval.proposalId === proposal.proposalId && approval.actionDigest === proposal.actionDigest &&
    approval.expectedCampaignVersion === proposal.expectedCampaignVersion &&
    (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > now);
  return {
    id: approval.id, action: approval.action, actionDigest: approval.actionDigest, status: approval.status,
    issuedAt: approval.issuedAt, isActive,
    ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
    ...(approval.consumedAt === undefined ? {} : { consumedAt: approval.consumedAt }),
    ...(approval.proposalId === undefined ? {} : { proposalId: approval.proposalId }),
    ...(approval.expectedCampaignVersion === undefined ? {} : { expectedCampaignVersion: approval.expectedCampaignVersion }),
  };
}

function safeEventFacts(eventType: string, payload: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  if (eventType === "external_action_proposed") {
    const actionPayload = source.payload;
    const action = typeof actionPayload === "object" && actionPayload !== null && !Array.isArray(actionPayload)
      ? (actionPayload as Record<string, unknown>).action : undefined;
    return {
      ...(validFact("action", action) ? { action } : {}),
      ...(validFact("expectedCampaignVersion", source.expectedCampaignVersion) ? { expectedCampaignVersion: source.expectedCampaignVersion } : {}),
    };
  }
  const allowedByType: Readonly<Record<string, readonly string[]>> = {
    campaign_created: ["status"], campaign_operation_completed: ["operation", "status", "claimedCampaignVersion", "resultingCampaignVersion", "iteration", "testsPassed", "childSessionId", "sandboxSessionId", "currentCommitSha", "commitSha", "pullRequest"],
    campaign_operation_rejected: ["operation", "reason", "claimedCampaignVersion", "resultingCampaignVersion"],
    external_action_proposed: ["action", "claimedCampaignVersion"], external_action_attempted: ["action", "claimedCampaignVersion", "resultingCampaignVersion"], external_action_completed: ["action", "claimedCampaignVersion", "resultingCampaignVersion"], external_action_outcome_unknown: ["action", "reason", "claimedCampaignVersion", "resultingCampaignVersion"], external_action_reconciled: ["action", "disposition", "observedCanonicalHead", "reason", "claimedCampaignVersion", "resultingCampaignVersion"], external_action_stale_recovered: ["action", "reason", "claimedCampaignVersion", "resultingCampaignVersion"],
    qodo_review_claimed: ["outcome", "reviewIteration", "reviewId", "testsPassed", "complete", "commitSha", "pullRequest", "claimedCampaignVersion"], qodo_finding_recorded: ["iteration", "reviewId", "commitSha", "pullRequest", "claimedCampaignVersion"], quality_gate_passed: ["iteration", "reviewId", "commitSha", "pullRequest", "claimedCampaignVersion"], quality_gate_escalated: ["iteration", "reason", "reviewId", "commitSha", "pullRequest", "claimedCampaignVersion"], quality_gate_repair_requested: ["iteration", "reviewId", "commitSha", "pullRequest", "claimedCampaignVersion"], repair_execution_failed: ["reason", "reviewId", "commitSha", "pullRequest", "claimedCampaignVersion"],
    interrupted_operation_recovered: ["targetStatus", "reason", "claimedCampaignVersion"], preflight_execution_failed: ["reason", "claimedCampaignVersion"], implementation_execution_failed: ["reason", "claimedCampaignVersion"], verification_execution_failed: ["reason", "claimedCampaignVersion"],
  };
  const allowed = allowedByType[eventType];
  if (allowed === undefined) return {};
  const facts = Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    return validFact(key, value) ? [[key, value]] : [];
  }));
  const output = source.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return facts;
  for (const key of ["verdict", "status", "currentCommitSha", "commitSha", "testsPassed"] as const) {
    const value = (output as Record<string, unknown>)[key];
    if (validFact(key, value)) facts[`output.${key}`] = value;
  }
  return facts;
}

const factEnums: Readonly<Record<string, readonly string[]>> = {
  operation: ["preflight", "implement", "verify", "repair"], action: ["post_issue_comment", "request_assignment", "push_branch", "create_pr", "update_pr"],
  status: ["policy_review", "coordination_pending", "preflight", "quarantined", "baseline", "implementation", "verification", "contribution_approval", "pull_request_open", "qodo_review", "repair", "human_escalation", "merged", "closed", "withdrawn", "completed", "failed"],
  targetStatus: ["quarantined", "human_escalation"], outcome: ["pass", "repair", "escalate"], verdict: ["pass", "quarantine"],
  disposition: ["confirmed_completed", "confirmed_not_completed"],
  reason: ["maximum_qodo_iterations", "tests_failed", "repair_child_failed", "repair_cancelled", "invalid_preflight_output", "operation_result_not_safely_recorded", "external_action_result_unknown", "human_external_action_reconciliation", "operator_recovered_stale_active_claim", "operator_recovered_interrupted_operation"],
};
const publicEventTypes = new Set(["campaign_created", "campaign_operation_completed", "campaign_operation_rejected", "external_action_proposed", "external_action_attempted", "external_action_completed", "external_action_outcome_unknown", "external_action_reconciled", "external_action_stale_recovered", "interrupted_operation_recovered", "preflight_execution_failed", "implementation_execution_failed", "verification_execution_failed", "qodo_review_claimed", "qodo_finding_recorded", "quality_gate_passed", "quality_gate_escalated", "quality_gate_repair_requested", "repair_execution_failed"]);
function validFact(key: string, value: unknown): value is string | number | boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  const leaf = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  if (leaf === "currentCommitSha" || leaf === "commitSha" || leaf === "observedCanonicalHead") return /^[0-9a-f]{40}$/u.test(value);
  if (leaf === "pullRequest") return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(value);
  const values = factEnums[leaf];
  return values === undefined ? /^[A-Za-z0-9._:-]+$/u.test(value) : values.includes(value);
}

function publicApprovalProposal(proposal: NonNullable<ReturnType<typeof currentApprovalProposal>>): Readonly<Record<string, unknown>> {
  return {
    proposalId: proposal.proposalId,
    actionDigest: proposal.actionDigest,
    expectedCampaignVersion: proposal.expectedCampaignVersion,
    action: proposalActionSummary(proposal.payload, proposal.expectedCurrentCommitSha),
    brief: proposal.brief,
  };
}

function qualityEscalationReason(snapshot: CampaignSnapshot): string | null {
  if (snapshot.campaign.status !== "human_escalation") return null;
  for (const event of snapshot.events.toReversed()) {
    const facts = safeEventFacts(event.eventType, event.payload);
    if (event.eventType === "quality_gate_escalated" && ["maximum_qodo_iterations", "tests_failed", "repair_child_failed", "repair_cancelled"].includes(String(facts.reason))) return String(facts.reason);
    if (event.eventType === "repair_execution_failed" && facts.reason === "repair_child_failed") return "repair_child_failed";
    if ((event.eventType === "implementation_execution_failed" || event.eventType === "verification_execution_failed") && facts.reason === "operation_result_not_safely_recorded") return facts.reason;
    if (event.eventType === "interrupted_operation_recovered" && facts.targetStatus === "human_escalation") return "operator_recovered_interrupted_operation";
  }
  return null;
}

function validQodoUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && /^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*(?:\/files)?$/u.test(url.pathname) && (url.hash === "" || /^#(?:discussion_r|r)[1-9][0-9]*$/u.test(url.hash));
  } catch { return false; }
}

function assertValidEventSequence(snapshot: CampaignSnapshot): void {
  const seen = new Set<number>();
  for (const event of snapshot.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || seen.has(event.sequence)) throw new Error("Campaign event sequence is invalid");
    seen.add(event.sequence);
  }
}
