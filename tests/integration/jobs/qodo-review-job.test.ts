import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { parseQodoReviewComments } from "../../../src/adapters/qodo/github-review-parser.js";
import { HarnessUnavailable } from "../../../src/application/ports/harness.js";
import type { QodoReview, QodoReviewPort, QodoReviewRequest } from "../../../src/application/ports/qodo-review.js";
import { SyncReview } from "../../../src/application/sync-review.js";
import { createQodoReviewJob, type ReviewJobScheduler } from "../../../src/server/jobs/qodo-review-job.js";
import { campaign } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

const commitSha = "b".repeat(40);

describe("QodoReviewJob", () => {
  it("polls an eligible campaign through the Qodo port and passes a complete review", async () => {
    const fixture = await jobFixture("pass.json", 0);

    await fixture.job.tick();

    expect(fixture.review.requests).toHaveLength(1);
    expect(fixture.harness.operations).toEqual([]);
    expect((await fixture.store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", qodoIteration: 0, version: 2 });
  });

  it("persists actionable source evidence before starting one fresh repair child", async () => {
    const fixture = await jobFixture("actionable.json", 0);

    await fixture.job.tick();

    expect(fixture.harness.operations).toEqual(["repair"]);
    expect(fixture.harness.childSessions).toHaveLength(1);
    expect((await fixture.store.get("campaign-1"))?.campaign).toMatchObject({ status: "repair", qodoIteration: 1 });
    expect((await fixture.store.get("campaign-1"))?.qodoFindings).toEqual([
      expect.objectContaining({ id: "comment-101", severity: "high", path: "src/application/retry.ts", line: 42 }),
      expect.objectContaining({ id: "comment-102", severity: "suggestion" }),
    ]);
  });

  it("passes a subjective dismissal only when its technical rationale is durable", async () => {
    const fixture = await jobFixture("subjective.json", 1);

    await fixture.job.tick();

    expect(fixture.harness.operations).toEqual([]);
    expect((await fixture.store.get("campaign-1"))?.qodoFindings).toEqual([
      expect.objectContaining({ id: "comment-201", status: "dismissed", disposition: expect.stringContaining("outside the issue contract") }),
    ]);
  });

  it("leaves the quality gate pending when Qodo is unavailable", async () => {
    const fixture = await jobFixture("pass.json", 1);
    fixture.review.failure = new HarnessUnavailable();

    await fixture.job.tick();

    expect((await fixture.store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", qodoIteration: 1, version: 1 });
    expect((await fixture.store.get("campaign-1"))?.events).toEqual([]);
    expect(fixture.harness.operations).toEqual([]);
  });

  it("rejects duplicate finding IDs without writing or dispatching repair", async () => {
    const fixture = await jobFixture("actionable.json", 1);
    const first = fixture.review.result?.findings[0];
    if (first === undefined || fixture.review.result === undefined) throw new Error("Missing actionable finding");
    fixture.review.result = { ...fixture.review.result, findings: [first, first] };

    await fixture.job.tick();

    expect((await fixture.store.get("campaign-1"))?.qodoFindings).toEqual([]);
    expect((await fixture.store.get("campaign-1"))?.campaign.status).toBe("qodo_review");
    expect(fixture.harness.operations).toEqual([]);
  });

  it("moves iteration three to human escalation without starting sync or repair child four", async () => {
    const fixture = await jobFixture("third-iteration.json", 3);

    await fixture.job.tick();

    expect(fixture.review.requests).toHaveLength(0);
    expect(fixture.harness.childSessions).toHaveLength(0);
    expect((await fixture.store.get("campaign-1"))?.campaign.status).toBe("human_escalation");
    expect((await fixture.store.get("campaign-1"))?.events).toEqual([
      expect.objectContaining({ eventType: "quality_gate_escalated", payload: expect.objectContaining({ reason: "maximum_qodo_iterations", iteration: 3 }) }),
    ]);
  });

  it("does not mutate iteration-three state when current pull-request authority is missing", async () => {
    const fixture = await jobFixture("third-iteration.json", 3);
    const store = new FakeCampaignStore();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 3 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
    let eventNumber = 0;
    const syncReview = new SyncReview(store, fixture.harness, { now: () => "2026-08-26T00:00:00Z" }, { next: () => `authority-event-${String(++eventNumber)}` });
    const scheduler: ReviewJobScheduler = { setInterval: () => 1, clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, review: fixture.review, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 50 });

    await job.tick();

    expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", version: 1 });
    expect((await store.get("campaign-1"))?.events).toEqual([]);
  });

  it("single-flights overlapping ticks and propagates one bounded abort context", async () => {
    const fixture = await jobFixture("pass.json", 0);
    let release!: () => void;
    fixture.review.beforeResult = async () => new Promise<void>((resolve) => { release = resolve; });

    const first = fixture.job.tick();
    const second = fixture.job.tick();
    await vi.waitFor(() => { expect(fixture.review.requests).toHaveLength(1); });
    const request = fixture.review.requests[0];
    expect(request?.request.timeoutMs).toBe(50);
    expect(request?.request.signal?.aborted).toBe(false);
    release();
    await Promise.all([first, second]);

    expect(fixture.review.requests).toHaveLength(1);
  });

  it("aborts a hung Qodo port and stops within the configured deadline", async () => {
    const fixture = await jobFixture("pass.json", 0);
    fixture.review.beforeResult = async () => new Promise<void>(() => undefined);
    void fixture.job.tick();
    await vi.waitFor(() => { expect(fixture.review.requests).toHaveLength(1); });
    const started = Date.now();

    await fixture.job.stop();

    expect(Date.now() - started).toBeLessThan(150);
    expect(fixture.review.requests[0]?.request.signal?.aborted).toBe(true);
    expect((await fixture.store.get("campaign-1"))?.campaign.status).toBe("qodo_review");
  });

  it("catches store enumeration failure and exposes only sanitized health", async () => {
    const fixture = await jobFixture("pass.json", 0);
    const store = new Proxy(fixture.store, {
      get(target, property) {
        if (property === "listByStatus") return async () => { throw new Error("password=secret database down"); };
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const scheduler: ReviewJobScheduler = { setInterval: () => 1, clearInterval: () => undefined };
    const job = createQodoReviewJob({ store, review: fixture.review, syncReview: { execute: async () => campaign() }, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 50 });

    await expect(job.tick()).resolves.toBeUndefined();
    expect(job.health()).toEqual({ status: "degraded", code: "store_unavailable" });
    expect(JSON.stringify(job.health())).not.toContain("secret");
  });

  it("contains a campaign tick rejection without an unhandled scheduled promise", async () => {
    const fixture = await jobFixture("pass.json", 0);
    let scheduled: (() => void) | undefined;
    const scheduler: ReviewJobScheduler = { setInterval: (callback) => { scheduled = callback; return 1; }, clearInterval: () => undefined };
    const job = createQodoReviewJob({
      store: fixture.store,
      review: fixture.review,
      syncReview: { execute: async () => { throw new Error("token=secret"); } },
      scheduler,
      intervalMs: 10_000,
      shutdownTimeoutMs: 50,
    });
    job.start();
    scheduled?.();
    await vi.waitFor(() => { expect(job.health()).toEqual({ status: "degraded", code: "campaign_retry_pending" }); });
    expect(JSON.stringify(job.health())).not.toContain("secret");
    await job.stop();
  });
});

class FakeQodoReview implements QodoReviewPort {
  readonly requests: { repository: string; pullRequestNumber: number; request: QodoReviewRequest }[] = [];
  result?: QodoReview;
  failure?: Error;
  beforeResult?: () => Promise<void>;

  async getReview(repository: string, pullRequestNumber: number, request: QodoReviewRequest): Promise<QodoReview> {
    this.requests.push({ repository, pullRequestNumber, request });
    await this.beforeResult?.();
    if (this.failure !== undefined) throw this.failure;
    if (this.result === undefined) throw new Error("Missing review result");
    return this.result;
  }
}

async function jobFixture(fixtureName: string, iteration: number) {
  const fixture = await loadFixture(fixtureName);
  const store = new FakeCampaignStore();
  store.seed(campaign({ status: "qodo_review", qodoIteration: iteration }));
  store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
  store.seedExternalReference("campaign-1", { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
  const harness = new FakeHarness();
  const review = new FakeQodoReview();
  review.result = {
    syncSessionId: "authenticated-sync-session-1",
    reviewId: String(fixture.reviewId),
    reviewUrl: String(fixture.reviewUrl),
    sourceIdentity: String(fixture.sourceIdentity),
    sourceReceipt: String(fixture.sourceReceipt),
    commitSha: String(fixture.commitSha),
    testsPassed: Boolean(fixture.testsPassed),
    complete: Boolean(fixture.complete),
    findings: parseQodoReviewComments(fixture.comments, {
      repository: "owner/repo",
      pullRequestNumber: 7,
      allowlistedBotIdentities: ["qodo-merge-pro[bot]"],
    }),
  };
  let eventNumber = 0;
  const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:00:00Z" }, { next: () => `job-event-${String(++eventNumber)}` });
  const scheduler: ReviewJobScheduler = { setInterval: () => 1, clearInterval: () => undefined };
  const job = createQodoReviewJob({ store, review, syncReview, scheduler, intervalMs: 10_000, shutdownTimeoutMs: 50 });
  return { store, harness, review, job };
}

interface RawReviewFixture {
  readonly reviewId: unknown;
  readonly reviewUrl: unknown;
  readonly sourceIdentity: unknown;
  readonly sourceReceipt: unknown;
  readonly commitSha: unknown;
  readonly testsPassed: unknown;
  readonly complete: unknown;
  readonly comments: readonly unknown[];
}

async function loadFixture(name: string): Promise<RawReviewFixture> {
  const contents = await readFile(new URL(`../../../fixtures/qodo/${name}`, import.meta.url), "utf8");
  return JSON.parse(contents) as RawReviewFixture;
}
