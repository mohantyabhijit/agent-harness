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
    await expect(
      service.execute({
        repository: "owner/repo",
        issueNumber: 42,
        issueUrl: first.issueUrl,
        lane: "easy_win",
      }),
    ).rejects.toThrow(/already exists/i);
    expect(harness.parentSessions).toEqual(["session-1"]);
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
      expect(rejected.reason).toEqual(new Error("Campaign already exists for this repository issue"));
    }
    const stored = await store.findByIssue("OWNER/REPO", 42);
    expect(stored?.campaign.parentSessionId).toBe("session-1");
    expect(harness.deletedSessions).toEqual(["session-2"]);
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
    expect(harness.deletedSessions).toEqual(["session-1"]);
    expect(await store.findByIssue("owner/repo", 42)).toBeUndefined();
  });
});
