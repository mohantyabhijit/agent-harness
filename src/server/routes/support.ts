import { z } from "zod";

import { externalActionDigest, validateExternalActionPayload, type ExternalActionPayload } from "../../application/external-action.js";
import type { CampaignSnapshot } from "../../application/ports/campaign-store.js";
import { isApprovalActionAllowed } from "../../domain/approval.js";

export const campaignIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
export const repositoryPartSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u);
export const repositorySchema = z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
export const issueNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const boundedUrlSchema = z.url().max(2_048);
const proposalTextSchema = z.string().trim().min(1).max(20_000);
const proposalEventSchema = z.object({
  payload: z.custom<ExternalActionPayload>((value) => {
    try {
      validateExternalActionPayload(value as ExternalActionPayload);
      return true;
    } catch {
      return false;
    }
  }),
  brief: z.object({
    policy: proposalTextSchema,
    approach: proposalTextSchema,
    files: z.array(proposalTextSchema).min(1).max(200),
    risks: z.array(proposalTextSchema).min(1).max(200),
    tests: z.array(proposalTextSchema).min(1).max(200),
    safetyResult: proposalTextSchema,
    qodoStatus: proposalTextSchema,
    aiDisclosure: proposalTextSchema,
  }).strict(),
}).strict();

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
    events: snapshot.events.map(({ id, eventType, occurredAt }) => ({ id, eventType, occurredAt })),
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

function publicApprovalProposal(snapshot: CampaignSnapshot): Readonly<Record<string, unknown>> | null {
  if (snapshot.externalActionClaims.some(({ status }) => status === "active" || status === "outcome_unknown")) return null;
  for (const event of snapshot.events.toReversed()) {
    if (event.eventType !== "external_action_proposed") continue;
    const parsed = proposalEventSchema.safeParse(event.payload);
    if (!parsed.success) continue;
    const { payload, brief } = parsed.data;
    if (
      payload.repository !== snapshot.campaign.repository ||
      payload.issueNumber !== snapshot.campaign.issueNumber ||
      !isApprovalActionAllowed(payload.action, snapshot.campaign.status) ||
      !proposalReferencesCurrentCampaign(payload, snapshot)
    ) return null;
    return { payload, actionDigest: externalActionDigest(payload), brief };
  }
  return null;
}

function proposalReferencesCurrentCampaign(payload: ExternalActionPayload, snapshot: CampaignSnapshot): boolean {
  if (payload.action === "push_branch" || payload.action === "create_pr" || payload.action === "update_pr") {
    const commits = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
    if (commits.length !== 1 || commits[0]?.value !== payload.commitSha) return false;
  }
  if (payload.action === "update_pr") {
    const pullRequests = snapshot.externalReferences.filter(({ kind }) => kind === "pull_request");
    return pullRequests.length === 1 && pullRequests[0]?.value === payload.pullRequest;
  }
  return true;
}
