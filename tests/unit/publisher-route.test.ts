import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPublisherRoutes } from "../../src/server/routes/publisher.js";
import { FakePublisher } from "../fakes/fake-publisher.js";

const repo = "octo/repo";
const issue = 12;
const sha = "a".repeat(40);
const push = { action: "push_branch" as const, repository: repo, issueNumber: issue, branch: "codex/fix", commitSha: sha };
const pr = { action: "create_pr" as const, repository: repo, issueNumber: issue, branch: "codex/fix", baseBranch: "main", commitSha: sha, title: "Fix issue", body: `Fix https://github.com/${repo}/issues/${String(issue)}\n\nVerified tests: npm test\nRisks: low\nRollback: revert commit\nAI disclosure: assisted` };

function appFor(result: unknown = { commitSha: sha }) {
  const app = Fastify();
  app.addHook("onRequest", async (request, reply) => { if (request.headers.authorization !== "Bearer operator-token") return reply.code(401).send({ code: "unauthorized" }); });
  const resultRecord = result as { commitSha?: string; pullRequest?: string };
  const publisher = new FakePublisher(resultRecord.commitSha ?? sha, resultRecord.pullRequest ?? `https://github.com/${repo}/pull/9`);
  const executeApprovedExternalAction = vi.fn(async (_id: string, request: { payload: typeof push | typeof pr }, callback: (action: unknown) => Promise<unknown>, completionReference: (result: unknown, action: unknown) => unknown) => {
    const authorized = { campaignId: "c", repository: repo, issueNumber: issue, issueUrl: `https://github.com/${repo}/issues/${String(issue)}`, action: request.payload.action, actionDigest: "sha256:" + "a".repeat(64), payload: request.payload };
    const callbackResult = await callback(authorized);
    completionReference(callbackResult, authorized);
    return result;
  });
  registerPublisherRoutes(app, { runCampaign: { executeApprovedExternalAction } as never, publisher });
  return { app, publisher, executeApprovedExternalAction };
}

describe("publisher route", () => {
  it("requires authentication", async () => {
    const { app } = appFor();
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", payload: { approvalId: "approval-1", payload: push } });
    expect(response.statusCode).toBe(401);
  });

  it("executes an exact-approved push through the injected publisher", async () => {
    const { app, publisher, executeApprovedExternalAction } = appFor();
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", headers: { authorization: "Bearer operator-token" }, payload: { approvalId: "approval-1", payload: push } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ commitSha: sha });
    expect(executeApprovedExternalAction).toHaveBeenCalledWith("c", expect.objectContaining({ approvalId: "approval-1", payload: push }), expect.any(Function), expect.any(Function));
    expect(publisher.pushes).toHaveLength(1);
  });

  it("executes PR creation and returns one canonical PR URL", async () => {
    const pullRequest = `https://github.com/${repo}/pull/9`;
    const { app, publisher } = appFor({ pullRequest });
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", headers: { authorization: "Bearer operator-token" }, payload: { approvalId: "approval-pr", payload: pr } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pullRequest });
    expect(publisher.pullRequests).toHaveLength(1);
  });

  it.each([
    ["wrong action", { ...push, action: "post_issue_comment", body: "x" }],
    ["missing PR evidence", { ...pr, body: "issue only" }],
    ["unknown fields", { ...push, extra: true }],
  ])("rejects malformed %s", async (_label, payload) => {
    const { app } = appFor();
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", headers: { authorization: "Bearer operator-token" }, payload: { approvalId: "approval-1", payload } });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-canonical publisher response", async () => {
    const { app } = appFor({ pullRequest: "https://evil.example/pull/1" });
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", headers: { authorization: "Bearer operator-token" }, payload: { approvalId: "approval-pr", payload: pr } });
    expect(response.statusCode).toBe(500);
  });

  it("treats a different pushed commit as an unknown outcome", async () => {
    const { app } = appFor({ commitSha: "b".repeat(40) });
    const response = await app.inject({ method: "POST", url: "/api/campaigns/c/publish", headers: { authorization: "Bearer operator-token" }, payload: { approvalId: "approval-1", payload: push } });
    expect(response.statusCode).toBe(500);
  });
});
