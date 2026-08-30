import { describe, expect, it } from "vitest";

import { FinalizeCampaign } from "../../../src/application/finalize-campaign.js";
import { campaign } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";

const brief = {
  problem: "The issue describes an incorrect boundary result.", likelyCause: "A documented guard is missing.", smallestFix: "Add the guard and regression test.",
  affectedAreas: ["src/boundary.ts"], tests: ["Run the regression test."], risks: ["The guard could expose invalid callers."], uncertainty: "Call sites require sandbox inspection.",
  evidence: [{ sourceUrl: "https://github.com/owner/repo/issues/42", observation: "The issue documents the expected result." }],
};

function service(store: FakeCampaignStore) {
  return new FinalizeCampaign(store, () => "2026-08-30T00:00:00Z", () => "finalized-event");
}

async function seededStore() {
  const store = new FakeCampaignStore();
  await store.create(campaign({ status: "policy_review", version: 1 }), { id: "created", eventType: "campaign_created", occurredAt: "2026-08-30T00:00:00Z", payload: { status: "policy_review", issueBrief: brief } });
  return store;
}

describe("FinalizeCampaign", () => {
  it("atomically finalizes the persisted brief once", async () => {
    const store = await seededStore();
    const result = await service(store).execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "finalize-once" });
    expect(result).toMatchObject({ status: "coordination_pending", version: 2 });
    expect((await store.get("campaign-1"))?.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "campaign_finalized" })]));
  });

  it("replays the same idempotency key without advancing twice", async () => {
    const store = await seededStore();
    const finalize = service(store);
    await finalize.execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "same-finalize" });
    const replay = await finalize.execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "same-finalize" });
    expect(replay.version).toBe(2);
    expect((await store.get("campaign-1"))?.events.filter(({ eventType }) => eventType === "campaign_finalized")).toHaveLength(1);
  });

  it("atomically replays concurrent requests with the same bound key", async () => {
    const store = await seededStore();
    const finalize = service(store);
    const results = await Promise.all([
      finalize.execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "concurrent-finalize" }),
      finalize.execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "concurrent-finalize" }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: "coordination_pending", version: 2 }),
      expect.objectContaining({ status: "coordination_pending", version: 2 }),
    ]);
    expect((await store.get("campaign-1"))?.events.filter(({ eventType }) => eventType === "campaign_finalized")).toHaveLength(1);
    await expect(finalize.execute({ campaignId: "campaign-1", expectedVersion: 2, idempotencyKey: "concurrent-finalize" })).rejects.toMatchObject({ code: "campaign_conflict" });
  });

  it("does not advance when the atomic event write fails", async () => {
    const store = await seededStore();
    store.failNextEvent = true;
    await expect(service(store).execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "atomic-failure" })).rejects.toThrow(/persistence/i);
    expect((await store.get("campaign-1"))?.campaign).toMatchObject({ status: "policy_review", version: 1 });
    expect((await store.get("campaign-1"))?.events).toHaveLength(1);
  });

  it("rejects a stale version, a different duplicate key, or a missing draft", async () => {
    const store = await seededStore();
    await expect(service(store).execute({ campaignId: "campaign-1", expectedVersion: 2, idempotencyKey: "stale-version" })).rejects.toMatchObject({ code: "campaign_conflict" });
    const missing = new FakeCampaignStore(); missing.seed(campaign({ status: "policy_review", version: 1 }));
    await expect(service(missing).execute({ campaignId: "campaign-1", expectedVersion: 1, idempotencyKey: "missing-brief" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
