import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthorizedPublisherAction, PublisherPort } from "../../application/ports/publisher.js";
import type { AuthorizedExternalAction, RunCampaign } from "../../application/run-campaign.js";
import { validateExternalActionPayload, isPullRequest, type ExternalActionPayload } from "../../application/external-action.js";
import { ApiProblem, campaignIdSchema } from "./support.js";

const params = z.object({ id: campaignIdSchema }).strict();
const body = z.object({ approvalId: campaignIdSchema, payload: z.record(z.string(), z.unknown()) }).strict();
const reconciliationBody = z.object({
  claimId: campaignIdSchema,
  disposition: z.enum(["confirmed_completed", "confirmed_not_completed"]),
  observedCanonicalHead: z.string().regex(/^[0-9a-f]{40}$/u).optional(),
  observedPullRequest: z.url().max(2_048).optional(),
}).strict();
export function registerPublisherRoutes(app: FastifyInstance, dependencies: { runCampaign: RunCampaign; publisher: PublisherPort }): void {
  app.post("/api/campaigns/:id/publish", async (request) => {
    const { id } = params.parse(request.params);
    const input = body.parse(request.body);
    const payload = input.payload as ExternalActionPayload;
    try {
      validateExternalActionPayload(payload);
    } catch {
      throw new ApiProblem(400, "invalid_request", "Invalid exact external action payload");
    }
    if (payload.action !== "push_branch" && payload.action !== "create_pr") {
      throw new ApiProblem(400, "invalid_request", "Only push_branch and create_pr can be published");
    }
    if (payload.action === "create_pr") assertPrBody(payload.body, payload.repository, payload.issueNumber);
    if (payload.action === "push_branch") {
      const result = await dependencies.runCampaign.executeApprovedExternalAction(id, { approvalId: input.approvalId, payload }, async (authorized) => {
        const published = await dependencies.publisher.pushBranch(publisherAction(authorized, "push_branch"));
        if (published.commitSha !== payload.commitSha) throw new Error("Publisher result did not match the exact approved commit");
        return published;
      }, () => ({ kind: "branch", value: payload.branch }));
      return { commitSha: result.commitSha };
    }
    const result = await dependencies.runCampaign.executeApprovedExternalAction(id, { approvalId: input.approvalId, payload }, async (authorized) => {
      const published = await dependencies.publisher.createPr(publisherAction(authorized, "create_pr"));
      if (!isPullRequest(published.pullRequest, payload.repository)) throw new Error("Publisher returned a non-canonical pull request");
      return published;
    }, (published) => ({ kind: "pull_request", value: published.pullRequest }));
    return { pullRequest: result.pullRequest };
  });
  app.post("/api/campaigns/:id/publication/reconcile", async (request) => {
    const { id } = params.parse(request.params);
    return dependencies.runCampaign.reconcileExternalAction(id, reconciliationBody.parse(request.body));
  });
}

function assertPrBody(body: string, repository: string, issueNumber: number): void {
  const required = [`https://github.com/${repository}/issues/${String(issueNumber)}`, "verified tests", "risks", "rollback", "AI disclosure"];
  if (!required.every(item => body.toLocaleLowerCase("en-US").includes(item.toLocaleLowerCase("en-US")))) throw new ApiProblem(400, "invalid_request", "PR body must include issue link, verified tests, risks, rollback, and AI disclosure");
}

function publisherAction<Action extends "push_branch" | "create_pr">(
  authorized: Readonly<AuthorizedExternalAction>,
  expectedAction: Action,
): AuthorizedPublisherAction<Action> {
  if (authorized.action !== expectedAction || authorized.payload.action !== expectedAction) {
    throw new Error("Authorized publisher action did not match its payload");
  }
  return authorized as AuthorizedPublisherAction<Action>;
}
