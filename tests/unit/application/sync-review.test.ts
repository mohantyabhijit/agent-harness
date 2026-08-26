import { describe, expect, it, vi } from "vitest";

import { SyncReview, type QodoReviewBatch } from "../../../src/application/sync-review.js";
import { RunCampaign } from "../../../src/application/run-campaign.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign, openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";
import { FakeRepairVerifier } from "../../fakes/fake-repair-verifier.js";

const commitSha = "b".repeat(40);

describe("SyncReview", () => {
  it("fails closed when a shape-valid repair has no independent verifier", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "candidate only", artifacts: [], output: repairOutput("c".repeat(40)) });
    const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:02:00Z" }, { next: (() => { let id = 0; return () => `unverified-${String(++id)}`; })() });

    await expect(syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }))).resolves.toMatchObject({ status: "human_escalation" });
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: commitSha });
    expect((await store.get("campaign-1"))?.events.some(({ eventType }) => eventType === "campaign_operation_completed")).toBe(false);
  });
  it("binds repair verification to the child, repository, and expected parent head", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    const verifier = new FakeRepairVerifier();
    verifier.failure = new Error("candidate commit does not descend from expected parent");
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "forged candidate", artifacts: [], output: {
      status: "completed",
      commitSha: "c".repeat(40),
      verification: {
        testsPassed: true,
        commands: ["echo tests passed"],
        evidence: [{ kind: "direct", sourceUrl: "https://attacker.example/fake", observation: "trust me" }],
      },
    } });
    let id = 0;
    const syncReview = new SyncReview(store, harness, { now: () => "2026-08-26T00:02:00Z" }, { next: () => `verifier-${String(++id)}` }, verifier);

    await expect(syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }))).resolves.toMatchObject({ status: "human_escalation" });
    expect(verifier.requests).toEqual([expect.objectContaining({
      campaignId: "campaign-1",
      repository: "owner/repo",
      pullRequest: "https://github.com/owner/repo/pull/7",
      childSessionId: "session-1",
      expectedParentCommitSha: commitSha,
    })]);
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: commitSha });
    expect((await store.get("campaign-1"))?.events.some(({ eventType }) => eventType === "campaign_operation_completed")).toBe(false);
  });
  it("treats an identical authenticated review replay as an idempotent no-op", async () => {
    const { syncReview, store } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const batch = reviewBatch({ reviewId: "review-replay", complete: true, findings: [] });

    await expect(syncReview.execute("campaign-1", batch)).resolves.toMatchObject({ version: 2 });
    await expect(syncReview.execute("campaign-1", batch)).resolves.toMatchObject({ version: 2 });
    expect((await store.get("campaign-1"))?.events.filter(({ eventType }) => eventType === "qodo_review_claimed")).toHaveLength(1);
  });
  it("rejects conflicting facts for an already claimed review identity", async () => {
    const { syncReview, store } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const batch = reviewBatch({ reviewId: "review-conflict", complete: true, findings: [] });
    await syncReview.execute("campaign-1", batch);

    await expect(syncReview.execute("campaign-1", { ...batch, testsPassed: false })).rejects.toMatchObject({ code: "campaign_conflict" });
    expect((await store.get("campaign-1"))?.campaign.version).toBe(2);
  });
  it("treats every incomplete review, including one with findings, as a durable no-op", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));

    await expect(syncReview.execute("campaign-1", reviewBatch({
      complete: false,
      testsPassed: true,
      findings: [openHighFinding],
    }))).resolves.toMatchObject({ status: "qodo_review", qodoIteration: 1, version: 1 });

    const snapshot = await store.get("campaign-1");
    expect(snapshot?.events).toEqual([]);
    expect(snapshot?.qodoFindings).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("rolls back campaign, findings, and events when atomic Qodo persistence fails", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    store.failNextEvent = true;

    await expect(syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }))).rejects.toThrow(/atomic/i);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.campaign).toMatchObject({ status: "qodo_review", qodoIteration: 0, version: 1 });
    expect(snapshot?.qodoFindings).toEqual([]);
    expect(snapshot?.events).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("escalates without repair authority when the child omits verification evidence", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "unverified", artifacts: [], output: { status: "completed", commitSha: "c".repeat(40) } });

    await expect(syncReview.execute("campaign-1", reviewBatch({ findings: [openHighFinding] }))).resolves.toMatchObject({ status: "human_escalation" });
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.externalReferences).toContainEqual({ kind: "commit", value: commitSha });
    expect(snapshot?.events.some(({ eventType }) => eventType === "campaign_operation_completed")).toBe(false);
    expect(snapshot?.events.at(-1)).toMatchObject({ eventType: "quality_gate_escalated", payload: expect.objectContaining({ reason: "repair_child_failed" }) });
  });
  it("atomically escalates a cancelled repair without accepting its late output", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    let release!: () => void;
    harness.beforeResult = async () => new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const executing = syncReview.execute("campaign-1", reviewBatch({ complete: true, findings: [openHighFinding] }), { signal: controller.signal, timeoutMs: 50 });
    await vi.waitFor(() => { expect(harness.operations).toContain("repair"); });
    controller.abort();
    release();
    await expect(executing).resolves.toMatchObject({ status: "human_escalation" });
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.events.some(({ eventType }) => eventType === "campaign_operation_completed")).toBe(false);
    expect(snapshot?.events.at(-1)).toMatchObject({ eventType: "quality_gate_escalated", payload: expect.objectContaining({ reason: "repair_cancelled" }) });
    expect(snapshot?.campaign.status).toBe("human_escalation");
  });
  it("rolls back terminal status when escalation evidence cannot be persisted", async () => {
    const { syncReview, store } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 3 }));
    store.failNextEvent = true;

    await expect(syncReview.enforceIterationLimit("campaign-1")).rejects.toThrow(/event persistence/i);
    expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", version: 1, qodoIteration: 3 });
    expect((await store.get("campaign-1"))?.events).toEqual([]);
  });
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
    let currentCommit = commitSha;
    const repairCommits = ["c".repeat(40), "d".repeat(40), "e".repeat(40)];

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const nextCommit = repairCommits[iteration - 1];
      if (nextCommit === undefined) throw new Error("missing repair commit");
      harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });
      const repairing = await syncReview.execute("campaign-1", reviewBatch({
        reviewId: `review-${String(iteration)}`,
        reviewUrl: `https://github.com/owner/repo/pull/7#pullrequestreview-${String(iteration)}`,
        commitSha: currentCommit,
        findings: [{ ...openHighFinding, summary: `Unsafe retry ${String(iteration)}` }],
      }));
      expect(repairing.status).toBe("repair");
      expect(repairing.qodoIteration).toBe(iteration);
      const packet = harness.packets.at(-1);
      expect(packet?.goal).toContain(`iteration ${String(iteration)}`);
      expect(packet?.context).toMatchObject({
        reviewId: `review-${String(iteration)}`,
        commitSha: currentCommit,
        testsPassed: true,
        externalWritesAllowed: false,
        publicationRequiresFreshUpdatePrApproval: true,
      });
      const payload = {
        action: "update_pr" as const, repository: "owner/repo", issueNumber: 42,
        pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix-42",
        commitSha: nextCommit, body: `Publish repair ${String(iteration)}`,
      };
      await issueUpdateProposal(store, `approval-loop-${String(iteration)}`, payload, repairing.version);
      let actionEvent = 0;
      const runner = new RunCampaign(store, harness, { now: () => "2026-08-26T00:03:00Z" }, { next: () => `loop-${String(iteration)}-${String(++actionEvent)}` });
      await runner.executeApprovedExternalAction("campaign-1", { approvalId: `approval-loop-${String(iteration)}`, payload }, async () => undefined);
      expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "qodo_review", qodoIteration: iteration });
      currentCommit = nextCommit;
    }

    const escalated = await syncReview.execute("campaign-1", reviewBatch({
      reviewId: "review-4",
      reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-4",
      commitSha: currentCommit,
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
      body: "**Severity:** Low\nPrefer a broader refactor",
      path: "src/application/sync-review.ts",
      line: 18,
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
    ["malformed finding", reviewBatch({ findings: [{ ...openHighFinding, severity: "critical" as never }] })],
    ["oversized finding body", reviewBatch({ findings: [{ ...openHighFinding, body: "x".repeat(20_001) }] })],
    ["unsafe finding path", reviewBatch({ findings: [{ ...openHighFinding, path: "../secret" }] })],
    ["invalid finding line", reviewBatch({ findings: [{ ...openHighFinding, line: 0 }] })],
    ["non-GitHub finding source", reviewBatch({ findings: [{ ...openHighFinding, sourceUrl: "https://attacker.example/review/1" }] })],
    ["duplicate finding id", reviewBatch({ findings: [openHighFinding, { ...openHighFinding }] })],
    ["unknown batch field", { ...reviewBatch(), repository: "other/repo" }],
  ])("rejects a strict invalid review batch: %s", async (_label, batch) => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));

    await expect(syncReview.execute("campaign-1", batch)).rejects.toBeInstanceOf(Error);
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review for a commit that disagrees with durable campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: "c".repeat(40) });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toMatchObject({ code: "campaign_conflict" });
    expect(harness.operations).toEqual([]);
  });

  it("rejects a review identity that disagrees with pull-request campaign memory", async () => {
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
    store.seedExternalReference("campaign-1", { kind: "pull_request", value: "review-other" });

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toMatchObject({ code: "campaign_conflict" });
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

  it("does not rewrite an unchanged finding observed in a later review", async () => {
    const { syncReview, store } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 1 }));
    await store.recordQodoFinding("campaign-1", 1, openHighFinding);

    await syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-later", findings: [openHighFinding] }));

    expect((await store.get("campaign-1"))?.events.filter(({ eventType }) => eventType === "qodo_finding_recorded")).toEqual([]);
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
      eventType: "quality_gate_escalated",
      payload: { reason: "repair_child_failed", claimedCampaignVersion: 2 },
    });
    expect(JSON.stringify(snapshot?.events)).not.toContain("top-secret");
  });

  it("does not automatically leave human escalation for another repair", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "human_escalation", qodoIteration: 3 }));

    await expect(syncReview.execute("campaign-1", reviewBatch())).rejects.toMatchObject({ code: "invalid_transition" });
    expect(harness.operations).toEqual([]);
  });

  it("separates stable pull request, review run, and changing head across iterations", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    const first = reviewBatch({ reviewId: "review-a", findings: [openHighFinding] });
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });
    const repairing = await syncReview.execute("campaign-1", first);
    await expect(store.replaceCurrentCommit("campaign-1", "d".repeat(40), repairing.version, "repair")).rejects.toThrow(/repair/i);
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    await store.update(transitionCampaign(repairing, "qodo_review"), repairing.version);
    const fixed = { ...openHighFinding, status: "fixed" as const, disposition: "Fixed in repair commit" };
    const second = reviewBatch({ reviewId: "review-b", commitSha: nextCommit, findings: [fixed] });

    await expect(syncReview.execute("campaign-1", second)).resolves.toMatchObject({ status: "qodo_review" });
    await expect(syncReview.execute("campaign-1", second)).rejects.toMatchObject({ code: "campaign_conflict" });
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
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });

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
      expiresAt: "2026-08-26T00:02:00Z",
    }));
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    harness.beforeResult = async (operation) => { if (operation === "repair") { entered(); await resume; } };
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });
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
    await expect(runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update", payload }, callback)).rejects.toThrow(/approved proposal|approval/i);
    await issueUpdateProposal(store, "approval-update-fresh", payload, 3);
    await expect(runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update-fresh", payload }, callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("preserves iteration two after publishing the exact durable repair head", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });
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
    await issueUpdateProposal(store, "approval-update", payload, repairing.version);
    let externalEvent = 0;
    const runner = new RunCampaign(store, harness, { now: () => "2026-08-26T00:03:00Z" }, { next: () => `external-event-${String(++externalEvent)}` });
    await runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-update", payload }, async () => undefined);
    const publishedSnapshot = await store.get("campaign-1");
    if (publishedSnapshot === undefined) throw new Error("missing published repair campaign");
    const published = publishedSnapshot.campaign;
    expect(published).toMatchObject({ status: "qodo_review", version: repairing.version + 1, qodoIteration: 1 });
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    const fixed = { ...openHighFinding, status: "fixed" as const, disposition: "Fixed in approved repair commit" };
    await expect(syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-b", commitSha: nextCommit, findings: [fixed] }))).resolves.toMatchObject({ status: "qodo_review", qodoIteration: 1 });
  });

  it("reconciles a durably uncertain update_pr completion back to review atomically", async () => {
    const nextCommit = "c".repeat(40);
    const { syncReview, store, harness } = fixture();
    await seedReview(store, campaign({ status: "qodo_review", qodoIteration: 0 }));
    harness.enqueueResult("repair", { summary: "repair committed", artifacts: [], output: repairOutput(nextCommit) });
    const repaired = await syncReview.execute("campaign-1", reviewBatch({ reviewId: "review-reconcile", findings: [openHighFinding] }));
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: nextCommit,
      body: "Publish verified repair",
    };
    await issueUpdateProposal(store, "approval-reconcile", payload, repaired.version);
    let event = 0;
    const runner = new RunCampaign(store, harness, { now: () => "2026-08-26T00:03:00Z" }, { next: () => `reconcile-event-${String(++event)}` });
    store.failNextExternalCompletion = true;
    await expect(runner.executeApprovedExternalAction("campaign-1", { approvalId: "approval-reconcile", payload }, async () => undefined)).rejects.toThrow(/reconciliation required/i);
    const unknown = await store.get("campaign-1");
    const claimId = unknown?.externalActionClaims[0]?.id;
    if (claimId === undefined) throw new Error("missing update_pr claim");

    await expect(runner.reconcileExternalAction("campaign-1", { claimId, disposition: "confirmed_completed", observedCanonicalHead: nextCommit })).resolves.toMatchObject({ status: "qodo_review", version: repaired.version + 1 });
    const reconciled = await store.get("campaign-1");
    expect(reconciled?.externalReferences.filter(({ kind }) => kind === "commit")).toEqual([{ kind: "commit", value: nextCommit }]);
    expect(reconciled?.externalReferences.filter(({ kind }) => kind === "pull_request")).toEqual([{ kind: "pull_request", value: payload.pullRequest }]);
    expect(reconciled?.events.at(-1)).toMatchObject({ eventType: "external_action_reconciled", payload: expect.objectContaining({ resultingCampaignVersion: repaired.version + 1 }) });
  });
});

function reviewBatch(overrides: Partial<QodoReviewBatch> = {}): QodoReviewBatch {
  return {
    campaignId: "campaign-1",
    syncSessionId: "authenticated-sync-session-1",
    pullRequest: "https://github.com/owner/repo/pull/7",
    reviewId: "review-1",
    reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-1",
    sourceIdentity: "qodo-merge-pro[bot]",
    sourceReceipt: "authenticated-receipt-1",
    commitSha,
    testsPassed: true,
    complete: true,
    findings: [],
    ...overrides,
  };
}

function repairOutput(commitSha: string) {
  return {
    status: "completed",
    commitSha,
    verification: {
      testsPassed: true,
      commands: ["npm test"],
      evidence: [{ kind: "direct", sourceUrl: "https://github.com/owner/repo/actions/runs/1", observation: "All tests passed" }],
    },
  } as const;
}

async function seedReview(store: FakeCampaignStore, value: ReturnType<typeof campaign>): Promise<void> {
  store.seed(value);
  store.seedExternalReference(value.id, { kind: "commit", value: commitSha });
  store.seedExternalReference(value.id, { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" });
}

async function issueUpdateProposal(store: FakeCampaignStore, approvalId: string, payload: Extract<import("../../../src/application/external-action.js").ExternalActionPayload, { action: "update_pr" }>, version: number): Promise<void> {
  const proposalId = `proposal-${approvalId}`;
  const actionDigest = externalActionDigest(payload);
  await store.appendEvent("campaign-1", { id: proposalId, eventType: "external_action_proposed", occurredAt: "2026-08-26T00:02:30Z", payload: {
    proposalId, payload, actionDigest, expectedCampaignVersion: version, expectedCampaignStatus: "repair", expectedCurrentCommitSha: payload.commitSha,
    brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Passed", qodoStatus: "Review pending", aiDisclosure: "AI-assisted" },
  } });
  await store.issueApprovalForProposal({ campaignId: "campaign-1", proposalId, actionDigest, expectedVersion: version, approvalId, issuedAt: "2026-08-26T00:02:30Z", expiresAt: "2026-08-26T01:02:30Z", idempotencyKey: `key-${approvalId}` });
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
      new FakeRepairVerifier(),
    ),
    store,
    harness,
  };
}
