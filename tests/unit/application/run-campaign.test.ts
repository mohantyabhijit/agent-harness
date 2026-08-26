import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { RunCampaign } from "../../../src/application/run-campaign.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign } from "../../builders.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";
import { FakeHarness } from "../../fakes/fake-harness.js";

const commitSha = "a".repeat(40);
const requiredChecks = [
  "manifest_and_lifecycle_scripts",
  "suspicious_paths",
  "credential_and_secret_boundary",
  "network_behavior",
  "repository_metadata",
] as const;

describe("RunCampaign", () => {
  it("cannot request implementation before a passed preflight", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));

    await expect(service.execute("campaign-1", "implement")).rejects.toThrow(/preflight/i);
    expect(harness.operations).not.toContain("implement");
  });

  it("quarantines lifecycle-script text without running fixture code", async () => {
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
      output: preflightAttestation({
        verdict: "quarantine",
        quarantineReason: "preinstall performs a network download",
      }),
    });

    const result = await service.execute("campaign-1", "preflight");

    expect(result.status).toBe("quarantined");
    await expect(service.execute("campaign-1", "implement")).rejects.toThrow(/preflight/i);
    await expect(service.execute("campaign-1", "verify")).rejects.toThrow(/preflight/i);
    expect(harness.operations).toEqual(["preflight"]);
  });

  it.each([
    ["missing check", preflightAttestation({ checks: requiredChecks.slice(0, 4) })],
    ["duplicate check", preflightAttestation({ checks: [...requiredChecks.slice(0, 4), requiredChecks[0]] })],
    ["unknown check", preflightAttestation({ checks: [...requiredChecks.slice(0, 4), "trust_repository_readme"] })],
    ["noncanonical commit", preflightAttestation({ commitSha: "ABC123" })],
    ["dependencies installed", preflightAttestation({ dependenciesInstalled: true })],
    ["scripts executed", preflightAttestation({ repositoryScriptsExecuted: true })],
    ["contradictory pass", preflightAttestation({ quarantineReason: "unsafe" })],
    ["reasonless quarantine", preflightAttestation({ verdict: "quarantine" })],
    ["missing source-linked evidence", preflightAttestation({ evidence: [] })],
  ])("rejects an invalid trusted preflight attestation: %s", async (_label, output) => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));
    harness.enqueueResult("preflight", { summary: "preflight", artifacts: [], output });

    await expect(service.execute("campaign-1", "preflight")).rejects.toThrow(/quarantined/i);
    expect((await store.get("campaign-1"))?.campaign.status).toBe("quarantined");
  });

  it("does not auto-recover or dispatch a campaign already stranded in preflight", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "preflight", version: 2 }));

    const results = await Promise.allSettled([
      service.execute("campaign-1", "preflight"),
      service.execute("campaign-1", "preflight"),
    ]);

    expect(results.every(({ status }) => status === "rejected")).toBe(true);
    expect(harness.operations).toEqual([]);
  });

  it("records each child as session and sandbox identity with version-bound artifacts", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));

    expect((await service.execute("campaign-1", "preflight")).status).toBe("baseline");
    expect((await service.execute("campaign-1", "implement")).status).toBe("implementation");
    expect((await service.execute("campaign-1", "verify")).status).toBe("verification");

    expect(harness.childSessions).toEqual(["session-1", "session-2", "session-3"]);
    expect(harness.packets[1]?.currentCommitSha).toBe(commitSha);
    expect(harness.packets[2]?.currentCommitSha).toBe(commitSha);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.externalReferences.filter(({ kind }) => kind === "sandbox")).toEqual([
      { kind: "sandbox", value: "session-1" },
      { kind: "sandbox", value: "session-2" },
      { kind: "sandbox", value: "session-3" },
    ]);
    expect(snapshot?.events.map(({ payload }) => payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimedCampaignVersion: 2, sandboxSessionId: "session-1" }),
      expect.objectContaining({ claimedCampaignVersion: 5, sandboxSessionId: "session-2" }),
      expect.objectContaining({ claimedCampaignVersion: 6, sandboxSessionId: "session-3" }),
    ]));
  });

  it("requires durable implementation completion for the claimed campaign version", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "implementation", version: 4 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });

    await expect(service.execute("campaign-1", "verify")).rejects.toThrow(/implementation.*event/i);
    expect(harness.operations).toEqual([]);
  });

  it("blocks unsafe next steps after claim, child, reference, or event failures", async () => {
    for (const failure of ["claim", "child", "reference", "event"] as const) {
      const { service, store, harness } = fixture();
      store.seed(campaign({ status: "baseline", version: 3 }));
      store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
      if (failure === "claim") store.failNextUpdate = true;
      if (failure === "child") harness.enqueueFailure("implement", new Error("child failed"));
      if (failure === "reference") store.failNextExternalReference = true;
      if (failure === "event") store.failNextEvent = true;

      await expect(service.execute("campaign-1", "implement")).rejects.toThrow();
      await expect(service.execute("campaign-1", "verify")).rejects.toThrow();
      expect(harness.operations.filter((operation) => operation === "verify")).toEqual([]);
    }
  });

  it("claims a campaign version before dispatch so a concurrent milestone runs once", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "baseline", version: 3 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });

    const results = await Promise.allSettled([
      service.execute("campaign-1", "implement"),
      service.execute("campaign-1", "implement"),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(harness.operations).toEqual(["implement"]);
  });

  it("rotates a reported implementation head and verifies that exact commit", async () => {
    const nextCommit = "b".repeat(40);
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));
    await service.execute("campaign-1", "preflight");
    harness.enqueueResult("implement", { summary: "implemented", artifacts: [], output: { status: "completed", commitSha: nextCommit } });
    await service.execute("campaign-1", "implement");
    await service.execute("campaign-1", "verify");

    expect(harness.packets.at(-2)?.currentCommitSha).toBe(commitSha);
    expect(harness.packets.at(-1)?.currentCommitSha).toBe(nextCommit);
    expect((await store.get("campaign-1"))?.externalReferences.filter(({ kind }) => kind === "commit")).toEqual([{ kind: "commit", value: nextCommit }]);
    expect((await store.get("campaign-1"))?.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: "campaign_operation_completed", payload: expect.objectContaining({ output: expect.objectContaining({ previousCommitSha: commitSha, currentCommitSha: nextCommit }) }) })]));
  });

  it("fences a delayed verifier after recovery and blocks implementation before completion", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "policy_review" }));
    await service.execute("campaign-1", "preflight");
    await service.execute("campaign-1", "implement");
    let releaseResult!: () => void;
    let resultEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resultEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseResult = resolve; });
    harness.beforeResult = async (operation) => { if (operation === "verify") { resultEntered(); await release; } };

    const verifying = service.execute("campaign-1", "verify");
    await entered;
    await expect(service.execute("campaign-1", "implement")).rejects.toThrow(/verification completion/i);
    await service.recoverInterrupted("campaign-1");
    releaseResult();
    await expect(verifying).rejects.toThrow(/reconciliation|required/i);

    const snapshot = await store.get("campaign-1");
    expect(snapshot?.campaign.status).toBe("human_escalation");
    expect(snapshot?.externalReferences.some(({ value }) => value === "session-3")).toBe(false);
    expect(snapshot?.events.some(({ payload }) => JSON.stringify(payload).includes("session-3"))).toBe(false);
  });

  it("recovers interrupted operations without dispatch and only one concurrent recovery wins", async () => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status: "preflight", version: 2 }));
    const results = await Promise.allSettled([service.recoverInterrupted("campaign-1"), service.recoverInterrupted("campaign-1")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect((await store.get("campaign-1"))?.campaign.status).toBe("quarantined");
    expect(harness.operations).toEqual([]);
  });

  it.each([
    ["implementation", "human_escalation"],
    ["verification", "human_escalation"],
    ["repair", "human_escalation"],
  ] as const)("recovers interrupted %s to %s without dispatch", async (status, target) => {
    const { service, store, harness } = fixture();
    store.seed(campaign({ status, version: 4, qodoIteration: status === "repair" ? 1 : 0 }));
    await expect(service.recoverInterrupted("campaign-1")).resolves.toMatchObject({ status: target });
    expect(harness.operations).toEqual([]);
  });

  it("rejects a typed external payload for another campaign before consuming", async () => {
    const { service, store } = await approvedFixture();
    const action = vi.fn(async () => undefined);
    await expect(service.executeApprovedExternalAction("campaign-1", { approvalId: "approval-1", payload: { ...externalPayload, repository: "other/repo" } }, action)).rejects.toThrow(/identity/i);
    expect(action).not.toHaveBeenCalled();
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("consumes exact authorization, records attempt first, and passes a bound descriptor", async () => {
    const { service, store } = await approvedFixture();
    const action = vi.fn(async (authorized: unknown) => {
      const snapshot = await store.get("campaign-1");
      expect(snapshot?.approvals[0]?.status).toBe("consumed");
      expect(snapshot?.events.at(-1)?.eventType).toBe("external_action_attempted");
      expect(authorized).toEqual({
        campaignId: "campaign-1",
        repository: "owner/repo",
        issueNumber: 42,
        issueUrl: "https://github.com/owner/repo/issues/42",
        action: "create_pr",
        actionDigest: externalActionDigest(externalPayload),
        payload: externalPayload,
      });
      expect(Object.isFrozen(authorized)).toBe(true);
      expect(Object.isFrozen((authorized as { payload: object }).payload)).toBe(true);
      return "pull-request-7";
    });

    await expect(service.executeApprovedExternalAction("campaign-1", approvalRequest(), action))
      .resolves.toBe("pull-request-7");
    expect((await store.get("campaign-1"))?.events.map(({ eventType }) => eventType)).toEqual([
      "external_action_attempted",
      "external_action_completed",
    ]);
  });

  it("records fixed outcome-unknown evidence and never reuses approval after callback failure", async () => {
    const { service, store } = await approvedFixture();
    const action = vi.fn(async () => {
      throw new Error("token=top-secret remote payload");
    });

    const first = service.executeApprovedExternalAction("campaign-1", approvalRequest(), action);
    await expect(first).rejects.toEqual(new Error("External action outcome is unknown; reconciliation required"));
    expect(JSON.stringify((await store.get("campaign-1"))?.events)).not.toContain("top-secret");
    expect((await store.get("campaign-1"))?.events.map(({ eventType }) => eventType)).toEqual([
      "external_action_attempted",
      "external_action_outcome_unknown",
    ]);
    await expect(
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
    ).rejects.toThrow(/available/i);
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not call the external action when attempted evidence cannot be persisted", async () => {
    const { service, store } = await approvedFixture();
    store.failNextEvent = true;
    const action = vi.fn(async () => undefined);

    await expect(
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
    ).rejects.toThrow(/event persistence/i);
    expect(action).not.toHaveBeenCalled();
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
    expect((await store.get("campaign-1"))?.externalActionClaims).toEqual([]);
  });

  it("records outcome unknown when completion evidence fails after callback success", async () => {
    const { service, store } = await approvedFixture();
    const action = vi.fn(async () => {
      store.failNextEvent = true;
      return "pull-request-7";
    });

    await expect(
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
    ).rejects.toEqual(new Error("External action outcome is unknown; reconciliation required"));
    expect((await store.get("campaign-1"))?.events.map(({ eventType }) => eventType)).toEqual([
      "external_action_attempted",
      "external_action_outcome_unknown",
    ]);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("consumed");
  });

  it.each(["withdrawn", "quarantined"] as const)(
    "never consumes create_pr approval from %s",
    async (status) => {
      const { service, store } = fixture();
      store.seed(campaign({ status }));
      await store.recordApproval(issueApproval({
        id: "approval-1",
        campaignId: "campaign-1",
        action: "create_pr",
        actionDigest: externalActionDigest(externalPayload),
        issuedAt: "2026-08-26T00:00:00Z",
      }));
      store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
      const action = vi.fn(async () => undefined);

      await expect(
        service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
      ).rejects.toThrow(/state/i);
      expect(action).not.toHaveBeenCalled();
      expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
    },
  );

  it("loses authorization CAS when campaign is withdrawn after the service snapshot", async () => {
    const { service, store } = await approvedFixture();
    store.beforeConsumeApproval = async () => {
      const current = (await store.get("campaign-1"))?.campaign;
      if (current === undefined) throw new Error("missing fixture campaign");
      await store.update(transitionCampaign(current, "withdrawn"), current.version);
    };
    const action = vi.fn(async () => undefined);

    await expect(
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
    ).rejects.toThrow(/version|state/i);
    expect(action).not.toHaveBeenCalled();
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("loses authorization CAS when current head rotates after payload validation", async () => {
    const { service, store } = await approvedFixture();
    store.beforeConsumeApproval = async () => {
      await store.replaceCurrentCommit("campaign-1", "b".repeat(40), 7, "contribution_approval");
    };
    const action = vi.fn(async () => undefined);

    await expect(service.executeApprovedExternalAction("campaign-1", approvalRequest(), action)).rejects.toThrow(/version/i);
    expect(action).not.toHaveBeenCalled();
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("allows only one concurrent caller to cross the approval seam", async () => {
    const { service } = await approvedFixture();
    const action = vi.fn(async () => "pull-request-7");

    const results = await Promise.allSettled([
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
      service.executeApprovedExternalAction("campaign-1", approvalRequest(), action),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(action).toHaveBeenCalledOnce();
  });

  it("durably claims the exact payload before execution and blocks every conflicting mutation", async () => {
    const { service, store } = await approvedFixture();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const action = vi.fn(async (authorized: unknown) => {
      entered();
      const snapshot = await store.get("campaign-1");
      expect(snapshot?.externalActionClaims).toEqual([
        expect.objectContaining({ status: "active", payload: externalPayload, currentCommitSha: commitSha }),
      ]);
      expect(Object.isFrozen(authorized)).toBe(true);
      await resume;
      return "pull-request-7";
    });

    const executing = service.executeApprovedExternalAction("campaign-1", approvalRequest(), action);
    await paused;
    const claimed = await store.get("campaign-1");
    if (claimed === undefined) throw new Error("missing claimed campaign");
    await expect(store.update(transitionCampaign(claimed.campaign, "pull_request_open"), claimed.campaign.version)).rejects.toThrow(/external action/i);
    await expect(store.replaceCurrentCommit("campaign-1", "b".repeat(40), claimed.campaign.version, claimed.campaign.status)).rejects.toThrow(/external action/i);
    await expect(store.recordChildResult("campaign-1", {
      expectedVersion: claimed.campaign.version,
      expectedStatus: claimed.campaign.status,
      childSessionId: "conflicting-child",
      event: { id: "conflicting-event", eventType: "campaign_operation_completed", payload: { claimedCampaignVersion: claimed.campaign.version, resultingCampaignVersion: claimed.campaign.version }, occurredAt: "2026-08-26T00:01:00Z" },
    })).rejects.toThrow(/external action/i);
    await expect(service.executeApprovedExternalAction("campaign-1", approvalRequest(), async () => undefined)).rejects.toThrow(/external action|available/i);
    release();
    await expect(executing).resolves.toBe("pull-request-7");
    expect((await store.get("campaign-1"))?.externalActionClaims[0]?.status).toBe("completed");
  });

  it("rotates to the exact approved push commit only when completion is recorded", async () => {
    const nextCommit = "b".repeat(40);
    const pushPayload = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: nextCommit };
    const { service, store } = fixture();
    store.seed(campaign({ status: "contribution_approval", version: 7 }));
    store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
    await store.recordApproval(issueApproval({ id: "approval-push", campaignId: "campaign-1", action: "push_branch", actionDigest: externalActionDigest(pushPayload), issuedAt: "2026-08-26T00:00:00Z" }));

    await expect(service.executeApprovedExternalAction("campaign-1", { approvalId: "approval-push", payload: pushPayload }, async () => "pushed")).resolves.toBe("pushed");
    const completed = await store.get("campaign-1");
    expect(completed?.campaign.version).toBe(8);
    expect(completed?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    expect(completed?.externalActionClaims[0]).toMatchObject({ status: "completed", currentCommitSha: commitSha, payload: pushPayload });
  });

  it("keeps a failed callback fenced until explicit reconciliation without restoring approval", async () => {
    const { service, store } = await approvedFixture();
    await expect(service.executeApprovedExternalAction("campaign-1", approvalRequest(), async () => { throw new Error("secret remote failure"); })).rejects.toThrow(/outcome is unknown/i);
    const unknown = await store.get("campaign-1");
    if (unknown === undefined) throw new Error("missing unknown campaign");
    const claim = unknown.externalActionClaims[0];
    if (claim === undefined) throw new Error("missing external action claim");
    expect(claim.status).toBe("outcome_unknown");
    await expect(store.replaceCurrentCommit("campaign-1", "b".repeat(40), unknown.campaign.version, unknown.campaign.status)).rejects.toThrow(/external action/i);
    await expect(service.reconcileExternalAction("campaign-1", { claimId: "stale-claim", disposition: "confirmed_not_completed" })).rejects.toThrow(/claim/i);
    await expect(service.reconcileExternalAction("campaign-1", { claimId: claim.id, disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40) })).resolves.toMatchObject({ version: 8 });

    const reconciled = await store.get("campaign-1");
    if (reconciled === undefined) throw new Error("missing reconciled campaign");
    expect(reconciled.externalActionClaims[0]).toMatchObject({ status: "reconciled", disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40) });
    expect(reconciled.externalReferences).toContainEqual({ kind: "commit", value: "b".repeat(40) });
    expect(reconciled.approvals[0]?.status).toBe("consumed");
    await expect(service.executeApprovedExternalAction("campaign-1", approvalRequest(), async () => undefined)).rejects.toThrow(/available|current campaign head/i);
  });
});

function preflightAttestation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "pass",
    checks: [...requiredChecks],
    commitSha,
    dependenciesInstalled: false,
    repositoryScriptsExecuted: false,
    evidence: requiredChecks.map((check) => ({ check, sourceUrl: `https://github.com/owner/repo/blob/${commitSha}/package.json`, observation: `${check} inspected statically` })),
    ...overrides,
  };
}

function approvalRequest() {
  return {
    approvalId: "approval-1",
    payload: externalPayload,
  };
}

const externalPayload = {
  action: "create_pr" as const, repository: "owner/repo", issueNumber: 42,
  branch: "openquest/fix-42", baseBranch: "main", commitSha, title: "Fix issue 42", body: "Verified remediation",
};

async function approvedFixture() {
  const result = fixture();
  result.store.seed(campaign({ status: "contribution_approval", version: 7 }));
  result.store.seedExternalReference("campaign-1", { kind: "commit", value: commitSha });
  await result.store.recordApproval(issueApproval({
    id: "approval-1",
    campaignId: "campaign-1",
    action: "create_pr",
    actionDigest: externalActionDigest(externalPayload),
    issuedAt: "2026-08-26T00:00:00Z",
  }));
  return result;
}

function fixture(): { service: RunCampaign; store: FakeCampaignStore; harness: FakeHarness } {
  const store = new FakeCampaignStore();
  const harness = new FakeHarness();
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
  };
}
