import { describe, expect, it, vi } from "vitest";

import { HarnessUnavailable } from "../../../src/adapters/trueforge/harness.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import type { GithubCatalogPort } from "../../../src/application/ports/github-catalog.js";
import type { QodoReviewBatch } from "../../../src/application/sync-review.js";
import { SyncReview } from "../../../src/application/sync-review.js";
import { buildApp, type AppDependencies } from "../../../src/server/app.js";
import { parseConfig } from "../../../src/server/config.js";
import {
  createQodoReviewJob,
  type QodoReviewSource,
  type ReviewJobScheduler,
} from "../../../src/server/jobs/qodo-review-job.js";
import { spaces } from "../../../src/domain/discovery.js";
import { campaign } from "../../builders.js";
import { openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

describe("OpenQuest API", () => {
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
    expect((await app.inject({ method: "GET", url: "/api/spaces" })).json()).toEqual({ spaces });
    await app.close();
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

    const response = await app.inject({
      method: "POST",
      url: "/api/campaigns/campaign-1/approvals",
      payload: { payload },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      approval: { action: "create_pr", actionDigest: externalActionDigest(payload), status: "approved" },
      brief: {
        action: "Create pull request",
        repository: "owner/repo",
        issueNumber: 42,
        target: "main",
        title: "Fix issue 42",
        body: "Verified remediation",
      },
    });
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
    await store.recordApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: externalActionDigest(payload),
      status: "approved",
      issuedAt: "2026-08-26T00:00:00Z",
    });
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
    expect(response.json().events[0]).not.toHaveProperty("payload");
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

  it("synchronizes a current Qodo review once and rejects duplicate batches", async () => {
    const { app, store } = buildTestApp();
    const head = "a".repeat(40);
    store.seed(campaign({ status: "qodo_review", version: 1, qodoIteration: 0 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: head });
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
    const batch = reviewBatch({ commitSha: head });

    const first = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload: batch });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "qodo_review", version: 2 });
    const duplicate = await app.inject({ method: "POST", url: "/api/campaigns/campaign-1/reviews/sync", payload: batch });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
  });
});

describe("Qodo review job", () => {
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
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000 });

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
    const job = createQodoReviewJob({ store, source, syncReview, scheduler, intervalMs: 10_000 });

    await job.tick();

    expect((await store.get("campaign-1"))?.campaign.status).toBe("human_escalation");
    expect(harness.operations).not.toContain("repair");
  });
});

describe("server configuration", () => {
  it("applies safe defaults and rejects an unsafe polling interval", () => {
    expect(parseConfig({})).toEqual({
      PORT: 8788,
      DATABASE_PATH: "openquest.sqlite",
      TRUEFORGE_BASE_URL: "http://localhost:8790",
      QODO_POLL_INTERVAL_MS: 60_000,
    });
    expect(() => parseConfig({ QODO_POLL_INTERVAL_MS: "9999" })).toThrow();
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
  };
  return { app: buildApp(dependencies), store, harness };
}

function reviewBatch(overrides: Partial<QodoReviewBatch> = {}): QodoReviewBatch {
  return {
    campaignId: "campaign-1",
    pullRequest: "https://github.com/owner/repo/pull/7",
    reviewId: "review-1",
    commitSha: "a".repeat(40),
    testsPassed: true,
    complete: true,
    findings: [],
    ...overrides,
  };
}
