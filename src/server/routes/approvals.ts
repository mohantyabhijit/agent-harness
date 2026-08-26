import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { externalActionDigest, validateExternalActionPayload, type ExternalActionPayload } from "../../application/external-action.js";
import type { Clock, IdGenerator } from "../../application/create-campaign.js";
import type { CampaignStore, CampaignSnapshot } from "../../application/ports/campaign-store.js";
import { isApprovalActionAllowed, issueApproval as createApproval } from "../../domain/approval.js";
import { ApiProblem, campaignIdSchema, campaignNotFound, issueNumberSchema, repositorySchema } from "./support.js";

const textSchema = z.string().trim().min(1).max(20_000);
const branchSchema = z.string().min(1).max(255).regex(/^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]+(?<![./])$/u);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const basePayload = { repository: repositorySchema, issueNumber: issueNumberSchema };
const externalActionPayloadSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("post_issue_comment"), ...basePayload, body: textSchema }).strict(),
  z.object({ action: z.literal("request_assignment"), ...basePayload, assignee: z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u) }).strict(),
  z.object({ action: z.literal("push_branch"), ...basePayload, branch: branchSchema, commitSha: shaSchema }).strict(),
  z.object({ action: z.literal("create_pr"), ...basePayload, branch: branchSchema, baseBranch: branchSchema, commitSha: shaSchema, title: z.string().trim().min(1).max(256), body: textSchema }).strict(),
  z.object({ action: z.literal("update_pr"), ...basePayload, pullRequest: z.url().max(2_048), branch: branchSchema, commitSha: shaSchema, body: textSchema }).strict(),
]);
const approvalBodySchema = z.object({ payload: externalActionPayloadSchema, expiresAt: z.iso.datetime({ offset: true }).optional() }).strict();
const paramsSchema = z.object({ id: campaignIdSchema }).strict();
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/u);

export interface ApprovalRouteDependencies {
  readonly store: CampaignStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function registerApprovalRoutes(app: FastifyInstance, dependencies: ApprovalRouteDependencies): void {
  app.post("/api/campaigns/:id/approvals", async (request, reply) => {
    const { id } = paramsSchema.parse(request.params);
    const input = approvalBodySchema.parse(request.body);
    const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
    validateExternalActionPayload(input.payload);
    const snapshot = await dependencies.store.get(id);
    if (snapshot === undefined) throw campaignNotFound();
    assertApprovalCanBeIssued(snapshot, input.payload);
    const issuedAt = dependencies.clock.now();
    const approval = createApproval({
      id: dependencies.ids.next(),
      campaignId: id,
      action: input.payload.action,
      actionDigest: externalActionDigest(input.payload),
      issuedAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    const issued = await dependencies.store.issueApproval({ approval, idempotencyKey });
    return reply.code(201).send({ approval: issued, brief: actionBrief(input.payload) });
  });
}

function assertApprovalCanBeIssued(snapshot: CampaignSnapshot, payload: ExternalActionPayload): void {
  if (payload.repository !== snapshot.campaign.repository || payload.issueNumber !== snapshot.campaign.issueNumber) {
    throw new ApiProblem(409, "campaign_conflict", "Campaign conflicts with current state");
  }
  if (!isApprovalActionAllowed(payload.action, snapshot.campaign.status)) {
    throw new ApiProblem(422, "invalid_transition", "Campaign transition is not allowed");
  }
  if (payload.action === "create_pr" || payload.action === "update_pr") {
    const commits = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
    if (commits.length !== 1 || commits[0]?.value !== payload.commitSha) {
      throw new ApiProblem(409, "campaign_conflict", "Campaign conflicts with current state");
    }
  }
  if (payload.action === "update_pr") {
    const pullRequests = snapshot.externalReferences.filter(({ kind }) => kind === "pull_request");
    if (pullRequests.length !== 1 || pullRequests[0]?.value !== payload.pullRequest) {
      throw new ApiProblem(409, "campaign_conflict", "Campaign conflicts with current state");
    }
  }
}

function actionBrief(payload: ExternalActionPayload): Readonly<Record<string, unknown>> {
  const common = { repository: payload.repository, issueNumber: payload.issueNumber };
  switch (payload.action) {
    case "post_issue_comment": return { action: "Post issue comment", ...common, target: `#${String(payload.issueNumber)}`, body: payload.body };
    case "request_assignment": return { action: "Request issue assignment", ...common, target: payload.assignee };
    case "push_branch": return { action: "Push branch", ...common, target: payload.branch, commitSha: payload.commitSha };
    case "create_pr": return { action: "Create pull request", ...common, target: payload.baseBranch, branch: payload.branch, commitSha: payload.commitSha, title: payload.title, body: payload.body };
    case "update_pr": return { action: "Update pull request", ...common, target: payload.pullRequest, branch: payload.branch, commitSha: payload.commitSha, body: payload.body };
  }
}
