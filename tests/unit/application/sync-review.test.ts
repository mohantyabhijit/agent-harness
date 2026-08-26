import { describe, expect, it } from "vitest";

import { SyncReview, type QodoReviewBatch } from "../../../src/application/sync-review.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign, openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

const commitSha = "b".repeat(40);

describe("SyncReview", () => {
  it("starts no fourth repair session", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 3 }));

    const result = await syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }));

    expect(result.status).toBe("human_escalation");
    expect(harness.operations).not.toContain("repair");
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([openHighFinding]);
  });

  it("starts at most three fresh, review-bound repair sessions", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const repairing = await syncReview.execute("campaign-1", reviewBatch({
        reviewId: `review-${String(iteration)}`,
        findings: [{ ...openHighFinding, summary: `Unsafe retry ${String(iteration)}` }],
      }));
      expect(repairing.status).toBe("repair");
      expect(repairing.qodoIteration).toBe(iteration);
      const packet = harness.packets.at(-1);
      expect(packet?.goal).toContain(`iteration ${String(iteration)}`);
      expect(packet?.context).toMatchObject({
        reviewId: `review-${String(iteration)}`,
        commitSha,
        testsPassed: true,
      });
      const reviewPending = transitionCampaign(repairing, "qodo_review");
      await store.update(reviewPending, repairing.version);
    }

    const escalated = await syncReview.execute("campaign-1", reviewBatch({
      reviewId: "review-4",
      findings: [openHighFinding],
    }));
    expect(escalated.status).toBe("human_escalation");
    expect(harness.operations).toEqual(["repair", "repair", "repair"]);
  });

  it("persists complete review identity, findings, and dispositions before passing", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));
    const dismissed = {
      id: "qodo-low-1",
      severity: "low" as const,
      status: "dismissed" as const,
      summary: "Prefer a broader refactor",
      sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r1",
      disposition: "Out of scope for the focused issue fix",
    };

    const result = await syncReview.execute("campaign-1", reviewBatch({ findings: [dismissed] }));

    expect(result.status).toBe("qodo_review");
    expect(harness.operations).toEqual([]);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.qodoFindings).toEqual([dismissed]);
    expect(snapshot?.externalReferences).toContainEqual({ kind: "commit", value: commitSha });
    expect(snapshot?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "qodo_review_claimed",
        payload: expect.objectContaining({ reviewId: "review-1", commitSha, testsPassed: true }),
      }),
      expect.objectContaining({
        eventType: "qodo_finding_recorded",
        payload: expect.objectContaining({ reviewId: "review-1", commitSha, finding: dismissed }),
      }),
    ]));
  });

  it.each([
    ["cross campaign", reviewBatch({ campaignId: "campaign-other" })],
    ["blank review", reviewBatch({ reviewId: " " })],
    ["noncanonical commit", reviewBatch({ commitSha: "abc123" })],
    ["incomplete empty", reviewBatch({ complete: false, findings: [] })],
    ["malformed finding", reviewBatch({ findings: [{ ...openHighFinding, severity: "critical" as never }] })],
    ["unknown batch field", { ...reviewBatch(), repository: "other/repo" }],
  ])("rejects a strict invalid review batch: %s", async (_label, batch) => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));

    await expect(syncReview.execute("campaign-1", batch)).rejects.toThrow(/review|finding|campaign|commit/i);
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review for a commit that disagrees with durable campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));
    await store.setExternalReference("campaign-1", { kind: "commit", value: "c".repeat(40) });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toThrow(/stale|commit/i);
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review identity that disagrees with pull-request campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));
    await store.setExternalReference("campaign-1", { kind: "pull_request", value: "review-other" });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toThrow(/pull-request/i);
    expect(harness.operations).toEqual([]);
  });

  it("accepts an explicitly complete review with no findings", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));

    const result = await syncReview.execute("campaign-1", reviewBatch());

    expect(result.status).toBe("qodo_review");
    expect(result.version).toBe(2);
    expect(harness.operations).toEqual([]);
  });

  it("claims review state before findings and dispatch so duplicate sync launches once", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));
    const batch = reviewBatch({ findings: [openHighFinding] });

    const results = await Promise.allSettled([
      syncReview.execute("campaign-1", batch),
      syncReview.execute("campaign-1", batch),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(harness.operations).toEqual(["repair"]);
  });

  it("escalates with fixed evidence when a claimed repair child fails", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));
    harness.enqueueFailure("repair", new Error("token=top-secret"));

    const result = await syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }));

    expect(result.status).toBe("human_escalation");
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.events.at(-1)).toMatchObject({
      eventType: "repair_execution_failed",
      payload: { reason: "repair_child_failed", claimedCampaignVersion: 2 },
    });
    expect(JSON.stringify(snapshot?.events)).not.toContain("top-secret");
  });

  it("does not automatically leave human escalation for another repair", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "human_escalation", qodoIteration: 3 }));

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toThrow(/qodo review/i);
    expect(harness.operations).toEqual([]);
  });
});

function reviewBatch(overrides: Partial<QodoReviewBatch> = {}): QodoReviewBatch {
  return {
    campaignId: "campaign-1",
    reviewId: "review-1",
    commitSha,
    testsPassed: true,
    complete: true,
    findings: [],
    ...overrides,
  };
}

function fixture(): { syncReview: SyncReview; store: FakeCampaignStore; harness: FakeHarness } {
  const store = new FakeCampaignStore();
  const harness = new FakeHarness();
  let eventNumber = 0;
  return {
    syncReview: new SyncReview(
      store,
      harness,
      { now: () => "2026-08-26T00:02:00Z" },
      { next: () => `qodo-event-${String(++eventNumber)}` },
    ),
    store,
    harness,
  };
}
