import { describe, expect, it, vi } from "vitest";

import { HarnessOutputInvalid, HarnessUnavailable } from "../../../src/application/ports/harness.js";
import { externalActionDigest, type ExternalActionPayload } from "../../../src/application/external-action.js";
import type { CampaignStatus } from "../../../src/domain/campaign.js";
import type { GithubCatalogPort } from "../../../src/application/ports/github-catalog.js";
import type { QodoReviewBatch } from "../../../src/application/sync-review.js";
import type { QodoReviewPort } from "../../../src/application/ports/qodo-review.js";
import { SyncReview } from "../../../src/application/sync-review.js";
import { buildApp, type AppDependencies } from "../../../src/server/app.js";
import { createOpenQuestApi, type FetchLike } from "../../../src/web/api.js";
import { parseConfig } from "../../../src/server/config.js";
import {
  createQodoReviewJob,
  HarnessQodoReviewSource,
  type QodoReviewSource,
  type ReviewJobScheduler,
} from "../../../src/server/jobs/qodo-review-job.js";
import { spaces } from "../../../src/domain/discovery.js";
import { campaign } from "../../builders.js";
import { openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

describe("OpenQuest API", () => {
  it("allows campaign API requests without an operator capability", async () => {
    const qodoReview: QodoReviewPort = { getReview: async () => { throw new HarnessUnavailable(); } };
    const { app } = buildTestApp({ qodoReview });
    const payload = { repository: "owner/repo", issueNumber: 42, issueUrl: "https://github.com/owner/repo/issues/42", lane: "easy_win" };
    expect((await app.inject({ method: "POST", url: "/api/campaigns", payload })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
    await app.close();
  });

  it("validates the optional repository-review route before processing it", async () => {
    const qodoReview: QodoReviewPort = { getReview: async () => { throw new HarnessUnavailable(); } };
    const { app, store } = buildTestApp({ qodoReview });
    const head = "a".repeat(40);
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    const unknownQuery = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync?debug=1", payload: reviewBatch() });
    expect(unknownQuery.statusCode).toBe(400);
    expect(unknownQuery.json()).toEqual({ code: "invalid_request", message: "Request validation failed" });
    expect((await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload: reviewBatch() })).statusCode).toBe(400);
    await app.close();
  });

  it("maps expected transition failures to 422 and unexpected store failures to 500", async () => {
    const { app, store } = buildTestApp();
    store.seed(campaign({ status: "baseline" }));
    expect((await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/actions/preflight", payload: {} })).statusCode).toBe(422);
    await app.close();

    class FailingStore extends FakeCampaignStore {
      override async get(): Promise<never> { throw new Error("secret database logic failure"); }
    }
    const failing = buildTestApp({ store: new FailingStore() }).app;
    const response = await failing.inject({ method: "POST", url: "/api/campaigns/campaign-1/actions/preflight", payload: {} });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "internal_error", message: "Request could not be completed" });
    expect(response.body).not.toContain("secret database");
    await failing.close();
  });

  it("replays one approval confirmation without minting a second approval", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "Fix", body: "Body" };
    await appendProposal(store, payload, { id: "proposal-replay", version: 7, status: "contribution_approval", currentHead: head });
    const request = { method: "POST" as const, url: "/api/campaigns/campaign-1/approvals", headers: { "idempotency-key": "human-confirmation-001" }, payload: { proposalId: "proposal-replay", actionDigest: externalActionDigest(payload), expectedCampaignVersion: 7 } };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().approval.id).toBe(first.json().approval.id);
    expect((await store.get("campaign-1"))?.approvals).toHaveLength(1);
    expect(replay.body).not.toContain("human-confirmation-001");
    await app.close();
  });

  it("round-trips the exact sanitized approval DTO through Fastify and the production browser client", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "  Preserve exact title  ", body: "  Exact body bytes stay intact.  " };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    await appendProposal(store, payload, { id: "proposal-roundtrip", version: 7, status: "contribution_approval", currentHead: head });
    const fetcher: FetchLike = async (input, init) => {
      const method = init?.method === "POST" ? "POST" : "GET";
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const injected = await app.inject({ method, url, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(typeof init?.body === "string" ? { payload: init.body } : {}) });
      return new Response(injected.body, { status: injected.statusCode, headers: new Headers(injected.headers as Record<string, string>) });
    };
    const api = createOpenQuestApi({ fetch: fetcher });
    const confirmation = { proposalId: "proposal-roundtrip", actionDigest: externalActionDigest(payload), expectedCampaignVersion: 7 };

    const approval = await api.issueApproval("campaign-1", confirmation, "roundtrip-confirmation");
    const snapshot = await api.getCampaign("campaign-1");

    expect(Object.keys(approval).sort()).toEqual(["action", "actionDigest", "expectedCampaignVersion", "expiresAt", "id", "isActive", "issuedAt", "proposalId", "status"]);
    expect(approval).toEqual(snapshot.approvals[0]);
    expect(approval).toMatchObject({ proposalId: confirmation.proposalId, expectedCampaignVersion: 7, actionDigest: confirmation.actionDigest, isActive: true });
    expect(approval).not.toHaveProperty("payload");
    expect(approval).not.toHaveProperty("expectedCampaignStatus");
    expect(approval).not.toHaveProperty("expectedCurrentCommitSha");
    await app.close();
  });

  it("uses the injected request clock and permanently retires an observed expiry across clock rollback", async () => {
    let now = "2026-08-26T00:00:00Z";
    const { app, store } = buildTestApp({ clock: { now: () => now } });
    const head = "a".repeat(40);
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "Fix", body: "Body" };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    await appendProposal(store, payload, { id: "proposal-clock", version: 7, status: "contribution_approval", currentHead: head });
    const request = { method: "POST" as const, url: "/api/campaigns/campaign-1/approvals", headers: { "idempotency-key": "clock-confirmation" }, payload: { proposalId: "proposal-clock", actionDigest: externalActionDigest(payload), expectedCampaignVersion: 7 } };

    expect((await app.inject(request)).json().approval).toMatchObject({ issuedAt: "2026-08-26T00:00:00.000Z", isActive: true });
    now = "2026-08-26T00:11:00Z";
    expect((await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" })).json().approvals[0]).toMatchObject({ isActive: false });
    expect((await store.get("campaign-1"))?.approvals[0]).toMatchObject({ active: false });
    now = "2026-08-26T00:05:00Z";
    expect((await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" })).json().approvals[0]).toMatchObject({ isActive: false });
    await app.close();
  });

  it("requires a bounded human-confirmation key for approval issuance", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "Fix", body: "Body" };
    const missing = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/approvals", payload: { payload } });
    const oversized = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/approvals", headers: { "idempotency-key": "x".repeat(129) }, payload: { payload } });
    expect(missing.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect((await store.get("campaign-1"))?.approvals).toEqual([]);
    await app.close();
  });

  it("rejects multiline or transformed proposal identifiers at the approval route", async () => {
    const { app } = buildTestApp();
    for (const proposalId of ["proposal\nid", " proposal-id "]) {
      const response = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/approvals", headers: { "idempotency-key": "identifier-check" }, payload: { proposalId, actionDigest: `sha256:${"a".repeat(64)}`, expectedCampaignVersion: 7 } });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("maps malformed and oversized bodies to a fixed 400 problem", async () => {
    const { app } = buildTestApp();
    const oversized = await app.inject({ method: "POST", url: "/api/campaigns", headers: { "content-type": "application/json" }, payload: JSON.stringify({ value: "x".repeat(300_000) }) });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toEqual({ code: "invalid_request", message: "Request validation failed" });
    const malformed = await app.inject({ method: "POST", url: "/api/campaigns", headers: { "content-type": "application/json" }, payload: "{" });
    expect(malformed.statusCode).toBe(400);
    await app.close();
  });
  it("creates an isolated issue campaign", async () => {
    const { app } = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      payload: {
        repository: "owner/repo",
        issueNumber: 42,
        issueUrl: "https://github.com/owner/repo/issues/42",
        lane: "easy_win",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      repository: "owner/repo",
      issueNumber: 42,
      status: "policy_review",
    });
    await app.close();
  });

  it("reports health and the stable space catalog", async () => {
    const { app } = buildTestApp();

    expect((await app.inject({ method: "GET", url: "/api/healthz" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/api/readyz" })).json()).toEqual({ status: "ready" });
    expect((await app.inject({ method: "GET", url: "/api/spaces" })).json()).toEqual({ spaces });
    await app.close();

    const degraded = buildTestApp({ reviewHealth: () => ({ status: "degraded", code: "store_unavailable" }) }).app;
    expect((await degraded.inject({ method: "GET", url: "/api/healthz" })).json()).toEqual({ status: "degraded", review: { code: "store_unavailable" } });
    const notReady = await degraded.inject({ method: "GET", url: "/api/readyz" });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toEqual({ status: "not_ready", review: { code: "store_unavailable" } });
    await degraded.close();
  });

  it("strictly validates bounded inputs and maps duplicates and missing campaigns", async () => {
    const { app } = buildTestApp();
    const payload = {
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win",
    };
    await app.inject({ method: "POST", url: "/api/campaigns", payload });

    const duplicate = await app.inject({ method: "POST", url: "/api/campaigns", payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ code: "campaign_conflict", message: "Campaign conflicts with current state" });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      payload: { ...payload, unexpected: "not accepted" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ code: "invalid_request", message: "Request validation failed" });
    const unknownQuery = await app.inject({ method: "GET", url: "/api/spaces?debug=1" });
    expect(unknownQuery.statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/campaigns/missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: "campaign_not_found", message: "Campaign was not found" });
    await app.close();
  });

  it("runs only declared campaign operations and maps invalid transitions", async () => {
    const { app } = buildTestApp();
    await app.inject({
      method: "POST",
      url: "/api/campaigns",
      payload: {
        repository: "owner/repo",
        issueNumber: 42,
        issueUrl: "https://github.com/owner/repo/issues/42",
        lane: "easy_win",
      },
    });
    const campaignId = (await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" })).json().id as string;

    const preflight = await app.inject({ method: "POST", url: `/api/campaigns/${campaignId}/actions/preflight`, payload: {} });
    expect(preflight.statusCode).toBe(200);
    expect(preflight.json()).toMatchObject({ status: "baseline" });
    const repeated = await app.inject({ method: "POST", url: `/api/campaigns/${campaignId}/actions/preflight`, payload: {} });
    expect(repeated.statusCode).toBe(422);
    expect(repeated.json()).toEqual({ code: "invalid_transition", message: "Campaign transition is not allowed" });
    const externalBypass = await app.inject({ method: "POST", url: `/api/campaigns/${campaignId}/actions/create_pr`, payload: {} });
    expect(externalBypass.statusCode).toBe(400);
    await app.close();
  });

  it("issues one exact digest with an accessible brief without returning a raw payload", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    const payload = {
      action: "create_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      branch: "openquest/fix-42",
      baseBranch: "main",
      commitSha: head,
      title: "Fix issue 42",
      body: "Verified remediation",
    };
    await appendProposal(store, payload, { id: "proposal-create", version: 7, status: "contribution_approval", currentHead: head });

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns/campaign-1/approvals",
      headers: { "idempotency-key": "confirmation-key-1" },
      payload: { proposalId: "proposal-create", actionDigest: externalActionDigest(payload), expectedCampaignVersion: 7 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      approval: { action: "create_pr", actionDigest: externalActionDigest(payload), status: "approved" },
    });
    expect(response.json().approval.expiresAt).toBe("2026-08-26T00:10:00.000Z");
    expect(response.json()).not.toHaveProperty("payload");
    expect(response.body).not.toContain("parentSessionId");
    await app.close();
  });

  it("redacts external-action claim payloads from campaign snapshots", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    const payload = {
      action: "create_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      branch: "openquest/fix-42",
      baseBranch: "main",
      commitSha: head,
      title: "Fix issue 42",
      body: "Sensitive approval brief content",
    };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    await appendProposal(store, payload, { id: "proposal-redaction", version: 7, status: "contribution_approval", currentHead: head });
    await store.issueApprovalForProposal({ campaignId: "campaign-1", proposalId: "proposal-redaction", actionDigest: externalActionDigest(payload), expectedVersion: 7, approvalId: "approval-1", issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2026-08-26T01:00:00Z", idempotencyKey: "redaction-key" });
    await store.claimExternalAction("campaign-1", {
      claimId: "claim-1",
      approvalId: "approval-1",
      actionDigest: externalActionDigest(payload),
      payload,
      expectedCurrentCommitSha: head,
      expectedVersion: 7,
      expectedStatus: "contribution_approval",
      consumedAt: "2026-08-26T00:01:00Z",
      leaseStartedAt: "2026-08-26T00:01:00Z",
      attemptedEvent: {
        id: "attempt-1",
        eventType: "external_action_attempted",
        payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 7 },
        occurredAt: "2026-08-26T00:01:00Z",
      },
    });

    const response = await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("Sensitive approval brief content");
    expect(response.json().externalActionClaims[0]).not.toHaveProperty("payload");
    expect(response.body).not.toContain('"payload"');
    await app.close();
  });

  it("exposes only a server-validated durable exact-action proposal", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "Fix issue 42", body: "AI-assisted contribution reviewed by a human." };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    await appendProposal(store, payload, { id: "proposal-1", version: 7, status: "contribution_approval", currentHead: head });

    const response = await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" });

    expect(response.json().approvalProposal).toEqual({ proposalId: "proposal-1", actionDigest: externalActionDigest(payload), expectedCampaignVersion: 7, action: payload, brief: expect.objectContaining({ safetyResult: "Static preflight passed." }) });
    await app.close();
  });

  it("shows and binds both the source and target commit for a branch push", async () => {
    const { app, store } = buildTestApp();
    const source = "a".repeat(40);
    const target = "b".repeat(40);
    const payload = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: target };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: source });
    await appendProposal(store, payload, { id: "proposal-push", version: 7, status: "contribution_approval", currentHead: source });

    const response = await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" });

    expect(response.json().approvalProposal.action).toEqual({ action: "push_branch", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", sourceCommitSha: source, targetCommitSha: target });
    await app.close();
  });

  it("fails closed when a durable proposal does not match the current campaign head", async () => {
    const { app, store } = buildTestApp();
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: "a".repeat(40) });
    await store.appendEvent("campaign-1", {
      id: "stale-proposal",
      eventType: "external_action_proposed",
      occurredAt: "2026-08-26T00:05:00Z",
      payload: {
        payload: { action: "create_pr", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "b".repeat(40), title: "Stale", body: "Stale body" },
        brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Passed", qodoStatus: "Clear", aiDisclosure: "AI-assisted" },
      },
    });

    expect((await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" })).json().approvalProposal).toBeNull();
    await app.close();
  });

  it("does not resurrect an older valid proposal when the newest proposal is malformed", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    const payload = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: head, title: "Safe", body: "Safe body" };
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    await appendProposal(store, payload, { id: "proposal-valid", version: 7, status: "contribution_approval", currentHead: head });
    await store.appendEvent("campaign-1", { id: "aaa-malformed-newest", eventType: "external_action_proposed", occurredAt: "2026-08-26T00:00:00Z", payload: { payload } });
    expect((await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" })).json().approvalProposal).toBeNull();
    await app.close();
  });

  it("projects only event-type-specific public facts and never leaks arbitrary sentinel strings", async () => {
    const { app, store } = buildTestApp();
    const sentinel = "SECRET_SENTINEL_DO_NOT_RENDER";
    store.seed(campaign());
    await store.appendEvent("campaign-1", { id: "unknown-event", eventType: "provider_debug", occurredAt: "2026-08-26T00:00:00Z", payload: { reason: sentinel, output: { status: sentinel } } });

    const response = await app.inject({ method: "GET", url: "/api/campaigns/campaign-1" });

    expect(response.body).not.toContain(sentinel);
    expect(response.json().events).toEqual([]);
    await app.close();
  });

  it("maps catalog outages to a fixed non-secret problem", async () => {
    const catalog: GithubCatalogPort = {
      listRepositories: vi.fn(async () => { throw new HarnessUnavailable(); }),
      listIssues: vi.fn(async () => { throw new Error("sqlite token=do-not-leak"); }),
    };
    const { app } = buildTestApp({ catalog });

    const unavailable = await app.inject({
      method: "POST",
      url: "/api/discovery/repositories",
      payload: { spaces: ["developer_tools"] },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({ code: "harness_unavailable", message: "Agent harness is unavailable" });
    expect(unavailable.body).not.toContain("token");
    const internal = await app.inject({ method: "GET", url: "/api/discovery/repositories/owner/repo/issues" });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toEqual({ code: "internal_error", message: "Request could not be completed" });
    expect(internal.body).not.toContain("do-not-leak");
    await app.close();
  });

  it("resolves an opaque review locator through the injected authority and idempotently replays it", async () => {
    const head = "a".repeat(40);
    const batch = reviewBatch({ commitSha: head });
    const getReview = vi.fn(async () => ({
        syncSessionId: batch.syncSessionId,
        reviewId: batch.reviewId,
        reviewUrl: batch.reviewUrl,
        sourceIdentity: batch.sourceIdentity,
        sourceReceipt: batch.sourceReceipt,
        commitSha: batch.commitSha,
        testsPassed: batch.testsPassed,
        complete: batch.complete,
        findings: batch.findings,
      }));
    const qodoReview: QodoReviewPort = { getReview };
    const { app, store } = buildTestApp({ qodoReview });
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    const locator = { schemaVersion: "qodo_review_locator_v1", reviewUrl: batch.reviewUrl, sourceReceipt: batch.sourceReceipt };

    const first = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload: locator });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "qodo_review", version: 2 });
    const duplicate = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload: locator });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ version: 2 });
    expect(getReview).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("rejects forged review-provider facts at the HTTP trust boundary", async () => {
    const qodoReview: QodoReviewPort = { getReview: async () => { throw new HarnessUnavailable(); } };
    const { app, store } = buildTestApp({ qodoReview });
    const head = "a".repeat(40);
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });

    const forged = await app.inject({
      method: "POST",
      url: "/api/campaigns/campaign-1/reviews/sync",
      payload: reviewBatch({
        sourceIdentity: "qodo-merge-pro[bot]",
        sourceReceipt: "attacker-chosen-receipt",
        reviewUrl: "https://github.com/attacker/repo/pull/99#pullrequestreview-1",
        findings: [{ ...openHighFinding, id: "attacker-finding" }],
      }),
    });

    expect(forged.statusCode).toBe(400);
    expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", version: 1 });
    await app.close();
  });

  it.each([
    ["arbitrary receipt", { schemaVersion: "qodo_review_locator_v1", reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1", sourceReceipt: "attacker-receipt-0001" }, 503],
    ["cross-repository URL", { schemaVersion: "qodo_review_locator_v1", reviewUrl: "https://github.com/attacker/repo/pull/99#pullrequestreview-1", sourceReceipt: "authenticated-receipt-1" }, 503],
    ["attacker identity", { schemaVersion: "qodo_review_locator_v1", reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1", sourceReceipt: "authenticated-receipt-1", sourceIdentity: "qodo-merge-pro[bot]" }, 400],
    ["attacker finding IDs", { schemaVersion: "qodo_review_locator_v1", reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1", sourceReceipt: "authenticated-receipt-1", findings: [{ id: "attacker-finding" }] }, 400],
  ])("fails closed for HTTP %s without quality-gate writes", async (_label, payload, statusCode) => {
    const qodoReview: QodoReviewPort = { getReview: async () => { throw new HarnessOutputInvalid(); } };
    const { app, store } = buildTestApp({ qodoReview });
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: "a".repeat(40) });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });

    expect((await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload })).statusCode).toBe(statusCode);
    expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", version: 1 });
    expect((await store.get("campaign-1"))?.events).toEqual([]);
    await app.close();
  });
});

describe("Qodo review job", () => {
  it("stops during a hung repair and fences a provider that completes after shutdown", async () => {
    const innerStore = new FakeCampaignStore();
    const harness = new FakeHarness();
    const head = "a".repeat(40);
    innerStore.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));
    innerStore.seedExternalReference("campaign-1", { kind: "commit", value: head });
    innerStore.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    let releaseRepair!: () => void;
    const repairBlocked = new Promise<void>((resolve) => { releaseRepair = resolve; });
    harness.beforeResult = async () => repairBlocked;
    let closed = false;
    const callsAfterClose: string[] = [];
    const mutating = new Set(["update", "appendEvent", "recordQodoFinding", "applyQodoReview", "recordChildResult"]);
    const store = new Proxy(innerStore, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (closed && mutating.has(String(property))) callsAfterClose.push(String(property));
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
    const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:00:00Z" }, { next: (() => { let id = 0; return () => `cancel-${String(++id)}`; })() });
    const source: QodoReviewSource = { fetch: async () => reviewBatch({ findings: [openHighFinding], complete: true }) };
    const scheduler: ReviewJobScheduler = { setInterval: () => "timer", clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 20 });

    const tick = job.tick();
    await vi.waitFor(() => { expect(harness.operations).toContain("repair"); });
    await job.stop();
    closed = true;
    releaseRepair();
    await tick;

    expect(harness.requestOptions[0]?.signal?.aborted).toBe(true);
    expect(harness.requestOptions[0]?.timeoutMs).toBe(20);
    expect(callsAfterClose).toEqual([]);
    expect((await innerStore.get("campaign-1"))?.events.some(({ eventType }) => eventType === "campaign_operation_completed")).toBe(false);
  });
  it("rejects oversized provider output before durable review writes or repair children", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    harness.enqueueResult("sync_qodo", { summary: "oversized", artifacts: [], output: reviewBatch({ findings: Array.from({ length: 1_001 }, (_, index) => ({ ...openHighFinding, id: `finding-${String(index)}` })) }) });
    const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:00:00Z" }, { next: () => "event" });
    const scheduler: ReviewJobScheduler = { setInterval: () => "timer", clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, source: new HarnessQodoReviewSource(harness), syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 100 });

    await job.tick();

    const snapshot = await store.get("campaign-1");
    expect(snapshot?.events).toEqual([]);
    expect(snapshot?.qodoFindings).toEqual([]);
    expect(snapshot?.campaign.status).toBe("qodo_review");
    expect(harness.operations).toEqual([]);
  });
  it("aborts a hung source and stops within its bounded deadline without syncing afterward", async () => {
    const store = new FakeCampaignStore();
    store.seed(campaign({ status: "qodo_review" }));
    let observedSignal: AbortSignal | undefined;
    const source: QodoReviewSource = { fetch: async (_snapshot, options) => { observedSignal = options.signal; return new Promise(() => undefined); } };
    const syncReview = { execute: vi.fn(async () => campaign()) };
    const scheduler: ReviewJobScheduler = { setInterval: () => "timer", clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 20 });
    void job.tick();
    await vi.waitFor(() => { expect(observedSignal).toBeDefined(); });
    const started = Date.now();
    await job.stop();
    expect(Date.now() - started).toBeLessThan(100);
    expect(observedSignal?.aborted).toBe(true);
    expect(syncReview.execute).not.toHaveBeenCalled();
  });
  it("uses an injected scheduler, never overlaps ticks, and stops the timer", async () => {
    const store = new FakeCampaignStore();
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetch = vi.fn(async () => { await blocked; return reviewBatch(); });
    const source: QodoReviewSource = { fetch };
    const syncReview = { execute: vi.fn(async () => campaign()) };
    let scheduled: (() => void) | undefined;
    const clear = vi.fn();
    const scheduler: ReviewJobScheduler = {
      setInterval: (callback) => { scheduled = callback; return "timer-1"; },
      clearInterval: clear,
    };
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 100 });

    job.start();
    expect(scheduled).toBeTypeOf("function");
    const firstTick = job.tick();
    const overlappingTick = job.tick();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    release();
    await Promise.all([firstTick, overlappingTick]);
    expect(syncReview.execute).toHaveBeenCalledOnce();
    await job.stop();
    expect(clear).toHaveBeenCalledWith("timer-1");
  });

  it("escalates at iteration three without launching a fourth repair", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 3 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    let id = 0;
    const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:00:00Z" }, { next: () => `job-event-${String(++id)}` });
    const source: QodoReviewSource = { fetch: async () => reviewBatch({ commitSha: head, findings: [openHighFinding] }) };
    const scheduler: ReviewJobScheduler = { setInterval: () => "timer", clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 100 });

    await job.tick();

    expect((await store.get("campaign-1"))?.campaign.status).toBe("human_escalation");
    expect(harness.operations).not.toContain("repair");
  });
});

describe("server configuration", () => {
  it("applies safe defaults without runtime capabilities", () => {
    expect(parseConfig({})).toEqual({
      PORT: 8788,
      DATABASE_PATH: "openquest.sqlite",
      TRUEFORGE_BASE_URL: "http://localhost:8790",
    });
  });
});

function buildTestApp(overrides: Partial<AppDependencies> = {}) {
  const store = new FakeCampaignStore();
  const harness = overrides.harness ?? new FakeHarness();
  let id = 0;
  const dependencies: AppDependencies = {
    store: overrides.store ?? store,
    harness,
    catalog: overrides.catalog ?? {
      listRepositories: vi.fn(async () => []),
      listIssues: vi.fn(async () => []),
    },
    clock: overrides.clock ?? { now: () => "2026-08-26T00:00:00Z" },
    ids: overrides.ids ?? { next: () => `campaign-${String(++id)}` },
    ...(overrides.qodoReview === undefined ? {} : { qodoReview: overrides.qodoReview }),
    ...(overrides.reviewHealth === undefined ? {} : { reviewHealth: overrides.reviewHealth }),
  };
  return { app: buildApp(dependencies), store, harness };
}

function reviewBatch(overrides: Partial<QodoReviewBatch> = {}): QodoReviewBatch {
  return {
    campaignId: "campaign-1",
    syncSessionId: "authenticated-sync-session-1",
    pullRequest: "https://github.com/owner/repo/pull/7",
    reviewId: "review-1",
    reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
    sourceIdentity: "qodo-merge-pro[bot]",
    sourceReceipt: "authenticated-receipt-1",
    commitSha: "a".repeat(40),
    testsPassed: true,
    complete: true,
    findings: [],
    ...overrides,
  };
}

async function appendProposal(store: FakeCampaignStore, payload: ExternalActionPayload, binding: { id: string; version: number; status: CampaignStatus; currentHead?: string }): Promise<void> {
  await store.appendEvent("campaign-1", {
    id: binding.id,
    eventType: "external_action_proposed",
    occurredAt: "2026-08-26T00:05:00Z",
    payload: {
      proposalId: binding.id,
      payload,
      actionDigest: externalActionDigest(payload),
      expectedCampaignVersion: binding.version,
      expectedCampaignStatus: binding.status,
      ...(binding.currentHead === undefined ? {} : { expectedCurrentCommitSha: binding.currentHead }),
      brief: {
        policy: "Focused pull requests with tests are welcome.", approach: "Guard the empty result before reading it.", files: ["src/dependencies.ts"],
        risks: ["Provider responses may be malformed."], tests: ["npm test"], safetyResult: "Static preflight passed.",
        qodoStatus: "No open high-severity findings.", aiDisclosure: "AI-assisted contribution prepared by OpenQuest and reviewed by a human.",
      },
    },
  });
}
