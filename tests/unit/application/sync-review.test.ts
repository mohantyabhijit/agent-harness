import { describe, expect, it, vi } from "vitest";

import { SyncReview, type QodoReviewBatch } from "../../../src/application/sync-review.js";
import { RunCampaign } from "../../../src/application/run-campaign.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign, openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

const commitSha = "b".repeat(40);

describe("SyncReview", () => {
  it("starts no fourth repair session", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 3 }));

    const result = await syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }));

    expect(result.status).toBe("human_escalation");
    expect(harness.operations).not.toContain("repair");
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([openHighFinding]);
  });

  it("starts at most three fresh, review-bound repair sessions", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));

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
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
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
    ["duplicate finding id", reviewBatch({ findings: [openHighFinding, { ...openHighFinding }] })],
    ["unknown batch field", { ...reviewBatch(), repository: "other/repo" }],
  ])("rejects a strict invalid review batch: %s", async (_label, batch) => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));

    await expect(syncReview.execute("campaign-1", batch)).rejects.toThrow(/review|finding|campaign|commit/i);
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review for a commit that disagrees with durable campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: "c".repeat(40) });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toThrow(/stale|commit/i);
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review identity that disagrees with pull-request campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "review-other" });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toThrow(/pull-request/i);
    expect(harness.operations).toEqual([]);
  });

  it("accepts an explicitly complete review with no findings", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));

    const result = await syncReview.execute("campaign-1", reviewBatch());

    expect(result.status).toBe("qodo_review");
    expect(result.version).toBe(2);
    expect(harness.operations).toEqual([]);
  });

  it("claims review state before findings and dispatch so duplicate sync launches once", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const batch = reviewBatch({ findings: [openHighFinding] });

    const results = await Promise.allSettled([
      syncReview.execute("campaign-1", batch),
      syncReview.execute("campaign-1", batch),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(harness.operations).toEqual(["repair"]);
  });

  it("writes nothing when current head rotates between review snapshot and claim", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    store.beforeUpdate = async () => {
      await store.replaceCurrentCommit("campaign-1", "c".repeat(40), 1, "qodo_review");
    };

    await expect(syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }))).rejects.toThrow(/version/i);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.qodoFindings).toEqual([]);
    expect(snapshot?.events).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("escalates with fixed evidence when a claimed repair child fails", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
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

  it("separates stable pull request, review run, and changing head across iterations", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const first = reviewBatch({ reviewId: "review-a", findings: [openHighFinding] });
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: { status: "completed", commitSha: nextCommit } });
    const repairing = await syncReview.execute("campaign-1", first);
    await expect(store.replaceCurrentCommit("campaign-1", "d".repeat(40), repairing.version, "repair")).rejects.toThrow(/repair/i);
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    await store.update(transitionCampaign(repairing, "qodo_review"), repairing.version);
    const fixed = { ...openHighFinding, status: "fixed" as const, disposition: "Fixed in repair commit" };
    const second = reviewBatch({ reviewId: "review-b", commitSha: nextCommit, findings: [fixed] });

    await expect(syncReview.execute("campaign-1", second)).resolves.toMatchObject({ status: "qodo_review" });
    await expect(syncReview.execute("campaign-1", second)).rejects.toThrow(/already synchronized/i);
    const claimed = (await store.get("campaign-1"))?.events.filter(({ eventType }) => eventType === "qodo_review_claimed");
    expect(claimed).toHaveLength(2);
  });

  it("rejects independent head rotation after a repair claim and still records the child for the claimed head", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    harness.beforeResult = async (operation) => { if (operation === "repair") { entered(); await resume; } };
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: { status: "completed", commitSha: nextCommit } });

    const repairing = syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-race", findings: [openHighFinding] }));
    await paused;
    const claimed = await store.get("campaign-1");
    expect(claimed?.campaign.status).toBe("repair");
    if (claimed === undefined) throw new Error("missing claimed repair campaign");
    await expect(store.replaceCurrentCommit("campaign-1", "d".repeat(40), claimed.campaign.version, "repair")).rejects.toThrow(/repair/i);
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: commitSha });
    release();

    await expect(repairing).resolves.toMatchObject({ status: "repair", version: 3 });
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
  });

  it("rejects an approved update while repair is in flight and allows it only after the matching durable result", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: nextCommit,
      body: "Publish reviewed repair",
    };
    await store.recordApproval(issueApproval({
      id: "approval-update",
      campaignId: "campaign-1",
      action: "update_pr",
      actionDigest: externalActionDigest(payload),
      issuedAt: "2026-08-26T00:00:00Z",
    }));
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    harness.beforeResult = async (operation) => { if (operation === "repair") { entered(); await resume; } };
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: { status: "completed", commitSha: nextCommit } });
    const repairing = syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-race", findings: [openHighFinding] }));
    await paused;

    let externalEvent = 0;
    const runner = new RunCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:03:00Z" },
      { next: () => `external-event-${String(++externalEvent)}` },
      { externalActionClaimStaleAfterMs: 60_000 },
    );
    const callback = vi.fn(async () => undefined);
    await expect(runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update", payload }, callback)).rejects.toThrow(/repair|head|completion/i);
    expect(callback).not.toHaveBeenCalled();
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");

    release();
    await expect(repairing).resolves.toMatchObject({ status: "repair", version: 3 });
    await expect(runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update", payload }, callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("preserves iteration two after publishing the exact durable repair head", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: { status: "completed", commitSha: nextCommit } });
    const repairing = await syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-a", findings: [openHighFinding] }));
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: nextCommit,
      body: "Publish reviewed repair",
    };
    await store.recordApproval(issueApproval({ id: "approval-update", campaignId: "campaign-1", action: "update_pr", actionDigest: externalActionDigest(payload), issuedAt: "2026-08-26T00:00:00Z" }));
    let externalEvent = 0;
    const runner = new RunCampaign(store, harness, { now: () => "2026-08-26T00:03:00Z" }, { next: () => `external-event-${String(++externalEvent)}` });
    await runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update", payload }, async () => undefined);
    const publishedSnapshot = await store.get("campaign-1");
    if (publishedSnapshot === undefined) throw new Error("missing published repair campaign");
    const published = publishedSnapshot.campaign;
    expect(published).toMatchObject({ status: "repair", version: repairing.version });
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    await store.update(transitionCampaign(published, "qodo_review"), published.version);
    const fixed = { ...openHighFinding, status: "fixed" as const, disposition: "Fixed in approved repair commit" };
    await expect(syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-b", commitSha: nextCommit, findings: [fixed] }))).resolves.toMatchObject({ status: "qodo_review", qodoIteration: 1 });
  });
});

function reviewBatch(overrides: Partial<QodoReviewBatch> = {}): QodoReviewBatch {
  return {
    campaignId: "campaign-1",
    pullRequest: "https://github.com/owner/repo/pull/7",
    reviewId: "review-1",
    commitSha,
    testsPassed: true,
    complete: true,
    findings: [],
    ...overrides,
  };
}

async function seedReview(store: FakeCampaignStore, value: ReturnType<typeof campaign>): Promise<void> {
  store.seed(value);
  store.seedExternalReference(value.id, { kind: "commit", value: commitSha });
  store.seedExternalReference(value.id, { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
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
