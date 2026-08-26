import { z } from "zod";

import { currentApprovalProposal, proposalActionSummary } from "../../application/approval-proposal.js";
import type { CampaignSnapshot } from "../../application/ports/campaign-store.js";

export const campaignIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
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

export function publicCampaignSnapshot(snapshot: CampaignSnapshot): Readonly<Record<string, unknown>> {
  return {
    ...snapshot.campaign,
    evidence: snapshot.evidence,
    events: snapshot.events.map(({ id, eventType, occurredAt, payload }) => ({ id, eventType, occurredAt, facts: safeEventFacts(payload) })),
    approvals: snapshot.approvals.map(({ id, action, actionDigest, status, issuedAt, expiresAt, consumedAt }) => ({
      id,
      action,
      actionDigest,
      status,
      issuedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(consumedAt === undefined ? {} : { consumedAt }),
    })),
    qodoFindings: snapshot.qodoFindings,
    externalReferences: snapshot.externalReferences,
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
    approvalProposal: publicApprovalProposal(snapshot),
  };
}

function safeEventFacts(payload: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const source = payload as Record<string, unknown>;
  const allowed = ["operation", "action", "status", "outcome", "reason", "targetStatus", "claimedCampaignVersion", "resultingCampaignVersion", "reviewIteration", "iteration", "testsPassed", "complete", "reviewId", "childSessionId", "sandboxSessionId", "sandboxId", "currentCommitSha", "commitSha", "pullRequest"] as const;
  const facts = Object.fromEntries(allowed.flatMap((key) => {
    const value = source[key];
    return typeof value === "string" && value.length <= 2_048 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" ? [[key, value]] : [];
  }));
  const output = source.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return facts;
  for (const key of ["verdict", "status", "currentCommitSha", "commitSha", "testsPassed"] as const) {
    const value = (output as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length <= 2_048 || typeof value === "boolean") facts[`output.${key}`] = value;
  }
  return facts;
}

function publicApprovalProposal(snapshot: CampaignSnapshot): Readonly<Record<string, unknown>> | null {
  const proposal = currentApprovalProposal(snapshot);
  return proposal === null ? null : {
    proposalId: proposal.proposalId,
    actionDigest: proposal.actionDigest,
    expectedCampaignVersion: proposal.expectedCampaignVersion,
    action: proposalActionSummary(proposal.payload),
    brief: proposal.brief,
  };
}
