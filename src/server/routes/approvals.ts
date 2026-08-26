import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Clock, IdGenerator } from "../../application/create-campaign.js";
import type { CampaignStore } from "../../application/ports/campaign-store.js";
import { campaignIdSchema, campaignNotFound, publicApproval } from "./support.js";

const paramsSchema = z.object({ id: campaignIdSchema }).strict();
const approvalBodySchema = z.object({
  proposalId: z.string().trim().min(1).max(128),
  actionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  expectedCampaignVersion: z.number().int().positive(),
}).strict();
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/u);
const APPROVAL_TTL_MS = 10 * 60 * 1_000;

export interface ApprovalRouteDependencies { readonly store: CampaignStore; readonly clock: Clock; readonly ids: IdGenerator; }

export function registerApprovalRoutes(app: FastifyInstance, dependencies: ApprovalRouteDependencies): void {
  app.post("/api/campaigns/:id/approvals", async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const input = approvalBodySchema.parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    const issuedAt = canonicalNow(dependencies.clock.now());
    const expiresAt = new Date(Date.parse(issuedAt) + APPROVAL_TTL_MS).toISOString();
    const approval = await dependencies.store.issueApprovalForProposal({
      campaignId: id, proposalId: input.proposalId, actionDigest: input.actionDigest,
      expectedVersion: input.expectedCampaignVersion, approvalId: dependencies.ids.next(), issuedAt, expiresAt, idempotencyKey,
    });
    const snapshot = await dependencies.store.get(id);
    if (snapshot === undefined) throw campaignNotFound();
    return reply.code(201).send({ approval: publicApproval(snapshot, approval) });
  });
}

function canonicalNow(value: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error("Approval clock returned an invalid timestamp");
  return new Date(instant).toISOString();
}
