import { z } from "zod";

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
  };
}
