import { describe, expect, it } from "vitest";

import { SyncReview } from "../../../src/application/sync-review.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign, openHighFinding } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

describe("SyncReview", () => {
  it("starts no fourth repair session", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 3 }));

    const result = await syncReview.execute("campaign-1", openHighFinding);

    expect(result.status).toBe("human_escalation");
    expect(harness.operations).not.toContain("repair");
    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([openHighFinding]);
  });

  it("starts at most three fresh repair sessions and records all references", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 0 }));

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      const repairing = await syncReview.execute("campaign-1", {
        ...openHighFinding,
        summary: `Unsafe retry iteration ${String(iteration)}`,
      });
      expect(repairing.status).toBe("repair");
      expect(repairing.qodoIteration).toBe(iteration);
      const reviewPending = transitionCampaign(repairing, "qodo_review");
      await store.update(reviewPending, repairing.version);
    }

    const escalated = await syncReview.execute("campaign-1", openHighFinding);
    expect(escalated.status).toBe("human_escalation");
    expect(harness.operations).toEqual(["repair", "repair", "repair"]);
    expect(new Set(harness.childSessions).size).toBe(3);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.externalReferences.filter(({ kind }) => kind === "child_session")).toHaveLength(3);
    expect(snapshot?.externalReferences.filter(({ kind }) => kind === "sandbox")).toHaveLength(3);
  });

  it("persists each finding and technical disposition before passing the gate", async () => {
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

    const result = await syncReview.execute("campaign-1", dismissed);

    expect(result.status).toBe("qodo_review");
    expect(harness.operations).toEqual([]);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.qodoFindings).toEqual([dismissed]);
    expect(snapshot?.events.map(({ eventType }) => eventType)).toEqual([
      "qodo_finding_recorded",
      "quality_gate_passed",
    ]);
  });

  it("rejects malformed findings without persisting or dispatching them", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "qodo_review", qodoIteration: 1 }));

    await expect(
      syncReview.execute("campaign-1", { ...openHighFinding, severity: "critical" as never }),
    ).rejects.toThrow(/finding/i);

    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([]);
    expect(harness.operations).toEqual([]);
  });

  it("does not automatically leave human escalation for another repair", async () => {
    const { syncReview, store, harness } = fixture();
    store.seed(campaign({ status: "human_escalation", qodoIteration: 3 }));

    await expect(syncReview.execute("campaign-1", openHighFinding)).rejects.toThrow(/qodo review/i);
    expect(harness.operations).toEqual([]);
  });
});

function fixture(): {
  syncReview: SyncReview;
  store: FakeCampaignStore;
  harness: FakeHarness;
} {
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
