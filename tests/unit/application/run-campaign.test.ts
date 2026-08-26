import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { RunCampaign } from "../../../src/application/run-campaign.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { campaign } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

describe("RunCampaign", () => {
  it("cannot request implementation before a passed preflight", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));

    await expect(service.execute("campaign-1", "implement")).rejects.toThrow(/preflight/i);
    expect(harness.operations).not.toContain("implement");
  });

  it("quarantines a lifecycle script using static preflight text without running it", async () => {
    const packageText = await readFile(
      new URL("../../../fixtures/repositories/quarantined-demo/package.json", import.meta.url),
      "utf8",
    );
    expect(packageText).toContain('"preinstall"');
    expect(packageText).toContain("curl");
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));
    harness.enqueueResult("preflight", {
      summary: "Lifecycle script found by static manifest inspection",
      artifacts: ["artifacts/preflight.json"],
      output: {
        verdict: "quarantine",
        checks: ["package.json contains preinstall network download"],
        commitSha: "abc123",
      },
    });

    const result = await service.execute("campaign-1", "preflight");

    expect(result.status).toBe("quarantined");
    await expect(service.execute("campaign-1", "implement")).rejects.toThrow(/preflight/i);
    await expect(service.execute("campaign-1", "verify")).rejects.toThrow(/preflight/i);
    expect(harness.operations).toEqual(["preflight"]);
  });

  it("uses a fresh child session for each legal milestone and records its references", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));

    expect((await service.execute("campaign-1", "preflight")).status).toBe("baseline");
    expect((await service.execute("campaign-1", "implement")).status).toBe("implementation");
    expect((await service.execute("campaign-1", "verify")).status).toBe("verification");

    expect(harness.childSessions).toEqual(["session-1", "session-2", "session-3"]);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.externalReferences.filter(({ kind }) => kind === "child_session")).toEqual([
      { kind: "child_session", value: "session-1" },
      { kind: "child_session", value: "session-2" },
      { kind: "child_session", value: "session-3" },
    ]);
    expect(snapshot?.externalReferences.filter(({ kind }) => kind === "sandbox")).toHaveLength(3);
    expect(snapshot?.events.map(({ eventType }) => eventType)).toEqual([
      "campaign_operation_completed",
      "campaign_operation_completed",
      "campaign_operation_completed",
    ]);
  });

  it("claims a campaign version before dispatch so a concurrent milestone runs once", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "baseline" }));

    const results = await Promise.allSettled([
      service.execute("campaign-1", "implement"),
      service.execute("campaign-1", "implement"),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(harness.operations).toEqual(["implement"]);
  });

  it("rejects malformed preflight output without advancing to baseline", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));
    harness.enqueueResult("preflight", {
      summary: "Ambiguous preflight",
      artifacts: [],
      output: { verdict: "pass", checks: [], commitSha: "" },
    });

    await expect(service.execute("campaign-1", "preflight")).rejects.toThrow(/preflight output/i);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.campaign.status).toBe("preflight");
    expect(snapshot?.externalReferences).toEqual([
      { kind: "child_session", value: "session-1" },
    ]);
    expect(snapshot?.events[0]?.eventType).toBe("campaign_operation_rejected");
  });

  it("atomically consumes the exact persisted approval immediately before an external action", async () => {
    const { service, store, callOrder } = fixture();
    store.seed(campaign({ status: "contribution_approval" }));
    await store.recordApproval(
      issueApproval({
        id: "approval-1",
        campaignId: "campaign-1",
        action: "create_pr",
        actionDigest: "sha256:expected",
        issuedAt: "2026-08-26T00:00:00Z",
      }),
    );
    const action = vi.fn(async () => {
      callOrder.push("external-action");
      const snapshot = await store.get("campaign-1");
      expect(snapshot?.approvals[0]?.status).toBe("consumed");
      return "pull-request-7";
    });

    await expect(
      service.executeApprovedExternalAction(
        "campaign-1",
        { approvalId: "approval-1", action: "create_pr", actionDigest: "sha256:wrong" },
        action,
      ),
    ).rejects.toThrow(/match/i);
    expect(action).not.toHaveBeenCalled();

    await expect(
      service.executeApprovedExternalAction(
        "campaign-1",
        { approvalId: "approval-1", action: "create_pr", actionDigest: "sha256:expected" },
        action,
      ),
    ).resolves.toBe("pull-request-7");
    expect(callOrder).toEqual(["consume-approval", "external-action"]);

    await expect(
      service.executeApprovedExternalAction(
        "campaign-1",
        { approvalId: "approval-1", action: "create_pr", actionDigest: "sha256:expected" },
        action,
      ),
    ).rejects.toThrow(/available/i);
    expect(action).toHaveBeenCalledOnce();
  });

  it("allows only one concurrent caller to cross the approval seam", async () => {
    const { service, store } = fixture();
    store.seed(campaign({ status: "contribution_approval" }));
    await store.recordApproval(
      issueApproval({
        id: "approval-1",
        campaignId: "campaign-1",
        action: "create_pr",
        actionDigest: "sha256:expected",
        issuedAt: "2026-08-26T00:00:00Z",
      }),
    );
    let actions = 0;
    const action = async () => {
      actions += 1;
      return "pull-request-7";
    };
    const request = {
      approvalId: "approval-1",
      action: "create_pr" as const,
      actionDigest: "sha256:expected",
    };

    const results = await Promise.allSettled([
      service.executeApprovedExternalAction("campaign-1", request, action),
      service.executeApprovedExternalAction("campaign-1", request, action),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(actions).toBe(1);
  });
});

function fixture(): {
  service: RunCampaign;
  store: FakeCampaignStore;
  harness: FakeHarness;
  callOrder: string[];
} {
  const store = new FakeCampaignStore();
  const harness = new FakeHarness();
  const callOrder: string[] = [];
  const originalConsumeApproval = store.consumeApproval.bind(store);
  store.consumeApproval = async (...args) => {
    const result = await originalConsumeApproval(...args);
    callOrder.push("consume-approval");
    return result;
  };
  let eventNumber = 0;
  return {
    service: new RunCampaign(
      store,
      harness,
      { now: () => "2026-08-26T00:01:00Z" },
      { next: () => `event-${String(++eventNumber)}` },
    ),
    store,
    harness,
    callOrder,
  };
}
