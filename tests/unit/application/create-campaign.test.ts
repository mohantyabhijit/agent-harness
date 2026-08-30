import { describe, expect, it } from "vitest";

import { CreateCampaign } from "../../../src/application/create-campaign.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

describe("CreateCampaign", () => {
  it("creates one parent session and rejects a duplicate issue campaign", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    const service = new CreateCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:00:00Z" },
      { next: () => "campaign-1" },
    );

    const first = await service.execute({
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win",
    });

    expect(first.parentSessionId).toBe("session-1");
    expect((await store.get(first.id))?.events).toEqual([
      expect.objectContaining({ eventType: "campaign_created" }),
    ]);
    await expect(
      service.execute({
        repository: "owner/repo",
        issueNumber: 42,
        issueUrl: first.issueUrl,
        lane: "easy_win",
      }),
    ).rejects.toMatchObject({ code: "campaign_conflict" });
    expect(harness.parentSessions).toEqual(["session-1"]);
    expect(harness.operations).toEqual(["policy"]);
    expect(harness.deletedSessions).toEqual(["session-2"]);
    expect(harness.requestOptions).toEqual([{ sessionLifecycle: "transient", sessionProfile: "policy" }]);
    expect(harness.packets[0]?.context?.responseSchema).toMatchObject({
      properties: {
        evidence: {
          items: {
            properties: {
              sourceUrl: {
                pattern: expect.stringContaining("owner/repo"),
              },
            },
          },
        },
      },
    });
  });

  it("fails closed and cleans up when TrueForge returns a malformed issue brief", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    harness.enqueueResult("policy", { summary: "invalid", artifacts: [], output: { problem: "missing evidence" } });
    const service = new CreateCampaign(store, harness, { now: () => "2026-08-26T00:00:00Z" }, { next: () => "campaign-1" });

    await expect(service.execute({ repository: "owner/repo", issueNumber: 42, issueUrl: "https://github.com/owner/repo/issues/42", lane: "easy_win" })).rejects.toThrow(/analysis could not be created/i);
    expect(await store.get("campaign-1")).toBeUndefined();
    expect(harness.deletedSessions).toEqual(["session-2", "session-1"]);
  });

  it("deletes only the losing unused parent session when duplicate creation races", async () => {
    const store = new FakeCampaignStore();
    const harness = new FakeHarness();
    let waiting = 0;
    let releaseCreates: () => void = () => undefined;
    const bothCreating = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    store.createBarrier = async () => {
      waiting += 1;
      if (waiting === 2) {
        releaseCreates();
      }
      await bothCreating;
    };
    const generatedIds = ["campaign-1", "campaign-2", "event-1"];
    const service = new CreateCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:00:00Z" },
      { next: () => generatedIds.shift() ?? "unexpected-id" },
    );
    const input = {
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win" as const,
    };

    const results = await Promise.allSettled([service.execute(input), service.execute(input)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "campaign_conflict" });
    }
    const stored = await store.findByIssue("OWNER/REPO", 42);
    expect(stored?.campaign.parentSessionId).toBe("session-1");
    expect(harness.deletedSessions).toEqual(["session-3", "session-4", "session-2"]);
  });

  it("compensates a failed persistence write and exposes no store details", async () => {
    class FailingStore extends FakeCampaignStore {
      override async create(): Promise<void> {
        throw new Error("database=/secret/path token=top-secret");
      }
    }
    const store = new FailingStore();
    const harness = new FakeHarness();
    const service = new CreateCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:00:00Z" },
      { next: () => "campaign-1" },
    );

    const result = service.execute({
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win",
    });

    await expect(result).rejects.toEqual(new Error("Campaign could not be created"));
    await expect(result).rejects.not.toThrow(/secret/u);
    expect(harness.deletedSessions).toEqual(["session-2", "session-1"]);
    expect(await store.findByIssue("owner/repo", 42)).toBeUndefined();
  });

  it("atomically rejects campaign and initial event together before compensating", async () => {
    const store = new FakeCampaignStore();
    store.failNextCreateEvent = true;
    const harness = new FakeHarness();
    const service = new CreateCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:00:00Z" },
      { next: () => "campaign-1" },
    );

    await expect(service.execute({
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win",
    })).rejects.toThrow(/could not be created/i);

    expect(await store.get("campaign-1")).toBeUndefined();
    expect(harness.deletedSessions).toEqual(["session-2", "session-1"]);
  });

  it("fails closed with cleanup-required evidence and never retries deletion", async () => {
    class FailingStore extends FakeCampaignStore {
      override async create(): Promise<void> {
        throw new Error("persistence failed");
      }
    }
    class CleanupFailingHarness extends FakeHarness {
      deleteAttempts = 0;
      override async deleteSession(): Promise<void> {
        this.deleteAttempts += 1;
        throw new Error("token=top-secret");
      }
    }
    const store = new FailingStore();
    const harness = new CleanupFailingHarness();
    const service = new CreateCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:00:00Z" },
      { next: () => "campaign-1" },
    );

    const result = service.execute({
      repository: "owner/repo",
      issueNumber: 42,
      issueUrl: "https://github.com/owner/repo/issues/42",
      lane: "easy_win",
    });
    await expect(result).rejects.toEqual(
      new Error("Campaign creation failed; unused session cleanup required"),
    );
    await expect(result).rejects.not.toThrow(/top-secret/u);
    expect(await store.get("campaign-1")).toBeUndefined();
    expect(harness.deleteAttempts).toBe(1);
  });

  it("matches SQLite global campaign-event identity semantics", async () => {
    const store = new FakeCampaignStore();
    store.seed({
      id: "campaign-a", repository: "owner/a", issueNumber: 1,
      issueUrl: "https://github.com/owner/a/issues/1", parentSessionId: "session-a",
      lane: "easy_win", status: "policy_review", qodoIteration: 0, version: 1,
    });
    store.seed({
      id: "campaign-b", repository: "owner/b", issueNumber: 2,
      issueUrl: "https://github.com/owner/b/issues/2", parentSessionId: "session-b",
      lane: "easy_win", status: "policy_review", qodoIteration: 0, version: 1,
    });
    const event = { id: "event-global", eventType: "test", payload: {}, occurredAt: "2026-08-26T00:00:00Z" };

    await store.appendEvent("campaign-a", event);
    await expect(store.appendEvent("campaign-b", event)).rejects.toThrow(/already exists/i);
  });
});
