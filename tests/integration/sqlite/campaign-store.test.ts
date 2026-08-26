/* eslint-disable @typescript-eslint/no-deprecated -- legacy consumeApproval port compatibility coverage */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCampaignStore } from "../../../src/adapters/sqlite/campaign-store.js";
import { RunCampaign } from "../../../src/application/run-campaign.js";
import { CampaignVersionConflict } from "../../../src/application/ports/campaign-store.js";
import type { CampaignStore, ExternalActionClaimRecord } from "../../../src/application/ports/campaign-store.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { transitionCampaign } from "../../../src/domain/campaign.js";
import { campaign, evidence } from "../../builders.js";
import { FakeHarness } from "../../fakes/fake-harness.js";
import { FakeCampaignStore } from "../../fakes/fake-campaign-store.js";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) {
      database.close();
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openMemoryStore(): { database: Database.Database; store: SqliteCampaignStore } {
  const database = new Database(":memory:");
  databases.push(database);
  return { database, store: new SqliteCampaignStore(database) };
}

function openTwoConnectionStore(prefix: string): {
  databaseA: Database.Database;
  databaseB: Database.Database;
  storeA: SqliteCampaignStore;
  storeB: SqliteCampaignStore;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  const path = join(directory, "campaigns.sqlite");
  const databaseA = new Database(path);
  const databaseB = new Database(path);
  databases.push(databaseA, databaseB);
  return { databaseA, databaseB, storeA: new SqliteCampaignStore(databaseA), storeB: new SqliteCampaignStore(databaseB) };
}

const externalPayload = {
  action: "create_pr" as const,
  repository: "owner/repo",
  issueNumber: 42,
  branch: "openquest/fix-42",
  baseBranch: "main",
  commitSha: "a".repeat(40),
  title: "Fix issue 42",
  body: "Verified remediation",
};

async function seedExternalActionCampaign(store: SqliteCampaignStore, database: Database.Database): Promise<void> {
  await store.create(campaign({ status: "contribution_approval", version: 7 }));
  database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", "a".repeat(40));
  await store.recordApproval(issueApproval({
    id: "approval-1",
    campaignId: "campaign-1",
    action: "create_pr",
    actionDigest: externalActionDigest(externalPayload),
    issuedAt: "2026-08-26T00:00:00Z",
  }));
}

function externalClaimRecord(): ExternalActionClaimRecord {
  return {
    claimId: "claim-1",
    approvalId: "approval-1",
    actionDigest: externalActionDigest(externalPayload),
    payload: externalPayload,
    expectedCurrentCommitSha: "a".repeat(40),
    expectedVersion: 7,
    expectedStatus: "contribution_approval",
    consumedAt: "2026-08-26T00:01:00Z",
    leaseStartedAt: "2026-08-26T00:01:00Z",
    attemptedEvent: {
      id: "attempt-1",
      eventType: "external_action_attempted",
      payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 7 },
      occurredAt: "2026-08-26T00:01:00Z",
    },
  };
}

function insertRepairAuthority(database: Database.Database, input: { eventId: string; currentHead: string; pullRequest: string; qodoIteration?: number }): void {
  database.prepare("INSERT INTO campaign_events (id, campaign_id, event_type, payload_json, occurred_at) VALUES (?, 'campaign-1', 'campaign_operation_completed', '{}', '2026-08-26T00:00:30Z')").run(input.eventId);
  database.prepare(`INSERT INTO campaign_operation_results
    (event_id, campaign_id, operation, resulting_campaign_version, current_commit_sha, pull_request, qodo_iteration, child_session_id)
    VALUES (?, 'campaign-1', 'repair', 3, ?, ?, ?, ?)`
  ).run(input.eventId, input.currentHead, input.pullRequest, input.qodoIteration ?? 1, `child-${input.eventId}`);
}

describe("SqliteCampaignStore", () => {
  it("fails migration with a fixed non-secret conflict when duplicate live approvals predate the unique index", async () => {
    const { database, store } = openMemoryStore();
    await store.create(campaign({ status: "contribution_approval" }));
    database.exec("DROP INDEX approvals_one_approved_digest_idx");
    const secretDigest = "sha256:secret-duplicate-action";
    database.prepare("INSERT INTO approvals (id, campaign_id, action, action_digest, status, issued_at) VALUES (?, 'campaign-1', 'create_pr', ?, 'approved', '2026-08-26T00:00:00Z')").run("legacy-a", secretDigest);
    database.prepare("INSERT INTO approvals (id, campaign_id, action, action_digest, status, issued_at) VALUES (?, 'campaign-1', 'create_pr', ?, 'approved', '2026-08-26T00:00:00Z')").run("legacy-b", secretDigest);

    let migrationError: unknown;
    try { new SqliteCampaignStore(database); } catch (error) { migrationError = error; }
    expect(migrationError).toMatchObject({ name: "CampaignMigrationConflict", code: "duplicate_live_approvals" });
    expect(String(migrationError)).not.toContain(secretDigest);
  });
  it.each([
    ["SQLite", () => openMemoryStore().store],
    ["fake", () => new FakeCampaignStore()],
  ])("rejects fabricated authoritative events in the %s store", async (_label, factory) => {
    const store = factory();
    if (store instanceof FakeCampaignStore) store.seed(campaign({ status: "repair", qodoIteration: 1 }));
    else await store.create(campaign({ status: "repair", qodoIteration: 1 }));
    await expect(store.appendEvent("campaign-1", { id: "forged", eventType: "campaign_operation_completed", payload: { operation: "repair" }, occurredAt: "2026-08-26T00:00:00Z" })).rejects.toThrow(/guarded|authoritative/i);
    await expect(store.appendEvent("campaign-1", { id: "forged-claim", eventType: "external_action_attempted", payload: {}, occurredAt: "2026-08-26T00:00:00Z" })).rejects.toThrow(/guarded|authoritative/i);
    expect((await store.get("campaign-1"))?.events).toHaveLength(0);
  });

  it("issues approvals idempotently and permits a fresh confirmation only after consumption", async () => {
    const { store, database } = openMemoryStore();
    await store.create(campaign({ status: "contribution_approval", version: 7 }));
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", "a".repeat(40));
    const first = issueApproval({ id: "approval-idem-1", campaignId: "campaign-1", action: "create_pr", actionDigest: externalActionDigest(externalPayload), issuedAt: "2026-08-26T00:00:00Z" });
    expect((await store.issueApproval({ approval: first, idempotencyKey: "confirmation-001" })).id).toBe(first.id);
    expect((await store.issueApproval({ approval: { ...first, id: "discarded" }, idempotencyKey: "confirmation-001" })).id).toBe(first.id);
    const concurrent = await Promise.allSettled([
      store.issueApproval({ approval: { ...first, id: "approval-idem-2" }, idempotencyKey: "confirmation-002" }),
      store.issueApproval({ approval: { ...first, id: "approval-idem-3" }, idempotencyKey: "confirmation-003" }),
    ]);
    expect(concurrent.every(({ status }) => status === "rejected")).toBe(true);
    await store.claimExternalAction("campaign-1", { ...externalClaimRecord(), approvalId: first.id });
    expect((await store.issueApproval({ approval: { ...first, id: "ignored-replay" }, idempotencyKey: "confirmation-001" })).status).toBe("consumed");
    await expect(store.issueApproval({ approval: { ...first, id: "approval-idem-fresh" }, idempotencyKey: "confirmation-004" })).resolves.toMatchObject({ id: "approval-idem-fresh", status: "approved" });
  });

  it("allows only one approved digest across concurrent confirmation keys and connections", async () => {
    const { storeA, storeB } = openTwoConnectionStore("openquest-approval-issuance-");
    await storeA.create(campaign({ status: "contribution_approval" }));
    const base = issueApproval({ id: "approval-a", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:same-action", issuedAt: "2026-08-26T00:00:00Z" });
    const results = await Promise.allSettled([
      storeA.issueApproval({ approval: base, idempotencyKey: "confirmation-A" }),
      storeB.issueApproval({ approval: { ...base, id: "approval-b" }, idempotencyKey: "confirmation-B" }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await storeA.get("campaign-1"))?.approvals.filter(({ status }) => status === "approved")).toHaveLength(1);
  });
  it("creates the campaign and initial event in one transaction", async () => {
    const { store } = openMemoryStore();
    const initialEvent = {
      id: "event-created",
      eventType: "campaign_created",
      payload: { status: "policy_review" },
      occurredAt: "2026-08-26T00:00:00Z",
    };

    await store.create(campaign(), initialEvent);
    expect((await store.get("campaign-1"))?.events).toEqual([
      { ...initialEvent, occurredAt: "2026-08-26T00:00:00.000Z" },
    ]);

    await expect(store.create(
      campaign({ id: "campaign-2", issueNumber: 43 }),
      { ...initialEvent, id: "event-invalid", occurredAt: "invalid" },
    )).rejects.toThrow(/invalid.*occurred/i);
    expect(await store.get("campaign-2")).toBeUndefined();

    await expect(store.create(
      campaign({ id: "campaign-3", issueNumber: 44 }),
      initialEvent,
    )).rejects.toThrow(/unique constraint/i);
    expect(await store.get("campaign-3")).toBeUndefined();
  });

  it("never returns evidence from another issue campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a", issueNumber: 1 }));
    await store.create(campaign({ id: "campaign-b", issueNumber: 2 }));
    await store.appendEvidence("campaign-a", evidence({
      id: "evidence-a",
      retrievedAt: "2026-08-26T14:00:00+14:00",
    }));

    expect((await store.get("campaign-b"))?.evidence).toEqual([]);
    expect((await store.get("campaign-a"))?.evidence[0]?.retrievedAt).toBe(
      "2026-08-26T00:00:00.000Z",
    );
  });

  it("enforces one campaign per repository issue and can find that campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a" }));

    await expect(
      store.create(campaign({ id: "campaign-b", repository: "Owner/Repo" })),
    ).rejects.toThrow(/unique constraint/i);
    expect((await store.findByIssue("OWNER/REPO", 42))?.campaign).toMatchObject({
      id: "campaign-a",
      repository: "owner/repo",
    });
  });

  it("requires exactly one version step and allows only one writer to win", async () => {
    const { store } = openMemoryStore();
    const original = campaign();
    await store.create(original);

    for (const malformedVersion of [1, 0, 3, 1.5]) {
      await expect(
        store.update({ ...original, status: "preflight", version: malformedVersion }, 1),
      ).rejects.toBeInstanceOf(CampaignVersionConflict);
    }

    const writerA = { ...original, status: "preflight" as const, version: 2 };
    const writerB = { ...original, status: "withdrawn" as const, version: 2 };
    await store.update(writerA, 1);

    await expect(store.update(writerB, 1)).rejects.toBeInstanceOf(CampaignVersionConflict);
    expect((await store.get(original.id))?.campaign).toMatchObject({
      status: "preflight",
      version: 2,
    });
  });

  it("rejects attempts to move immutable campaign identity", async () => {
    const { store } = openMemoryStore();
    const original = campaign();
    await store.create(original);

    for (const identityChange of [
      { repository: "other/repo" },
      { issueNumber: 99 },
      { issueUrl: "https://github.com/other/repo/issues/42" },
      { parentSessionId: "other-session" },
    ]) {
      await expect(
        store.update({ ...original, ...identityChange, status: "preflight", version: 2 }, 1),
      ).rejects.toThrow(/identity/i);
    }
    expect((await store.get(original.id))?.campaign).toEqual(original);
  });

  it("returns campaigns by status without crossing status boundaries", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a", issueNumber: 1, status: "preflight" }));
    await store.create(campaign({ id: "campaign-b", issueNumber: 2, status: "policy_review" }));

    expect((await store.listByStatus("preflight")).map(({ campaign: item }) => item.id)).toEqual([
      "campaign-a",
    ]);
  });

  it("assembles get, find, and list snapshots inside read transactions", async () => {
    const { database, store } = openMemoryStore();
    await store.create(campaign());
    await store.appendEvidence("campaign-1", evidence());
    const transactionStates: boolean[] = [];
    database.function("observe_snapshot_transaction", () => {
      transactionStates.push(database.inTransaction);
      return 1;
    });
    database.exec(`
      ALTER TABLE campaign_evidence RENAME TO campaign_evidence_data;
      CREATE VIEW campaign_evidence AS
      SELECT id, campaign_id, source_url, retrieved_at, observation, kind
      FROM campaign_evidence_data
      WHERE observe_snapshot_transaction() = 1;
    `);

    await store.get("campaign-1");
    await store.findByIssue("OWNER/REPO", 42);
    await store.listByStatus("policy_review");

    expect(transactionStates).toEqual([true, true, true]);
  });

  it("normalizes event times, orders by UTC instant and ID, and rejects malformed JSON", async () => {
    const { database, store } = openMemoryStore();
    await store.create(campaign());
    await store.appendEvent("campaign-1", {
      id: "event-later",
      eventType: "later",
      payload: { position: 2 },
      occurredAt: "2026-08-26T00:01:00Z",
    });
    await store.appendEvent("campaign-1", {
      id: "event-earlier",
      eventType: "earlier",
      payload: { position: 1 },
      occurredAt: "2026-08-26T14:00:00+14:00",
    });
    await store.appendEvent("campaign-1", {
      id: "event-tie-z",
      eventType: "tie",
      payload: {},
      occurredAt: "2026-08-26T00:02:00Z",
    });
    await store.appendEvent("campaign-1", {
      id: "event-tie-a",
      eventType: "tie",
      payload: {},
      occurredAt: "2026-08-26T14:02:00+14:00",
    });

    const events = (await store.get("campaign-1"))?.events;
    expect(events?.map((event) => event.id)).toEqual([
      "event-earlier",
      "event-later",
      "event-tie-a",
      "event-tie-z",
    ]);
    expect(events?.[0]?.occurredAt).toBe("2026-08-26T00:00:00.000Z");

    database.prepare("UPDATE campaign_events SET payload_json = ? WHERE id = ?").run("{", "event-later");
    await expect(store.get("campaign-1")).rejects.toThrow(/invalid payload json.*event-later/i);
  });

  it("rejects invalid evidence, event, approval, and consumption timestamps", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());

    await expect(
      store.appendEvidence("campaign-1", evidence({ retrievedAt: "2026-02-30T00:00:00Z" })),
    ).rejects.toThrow(/invalid.*retrieved/i);
    await expect(store.appendEvent("campaign-1", {
      id: "event-invalid",
      eventType: "invalid",
      payload: {},
      occurredAt: "2026-08-26T00:00:00+15:00",
    })).rejects.toThrow(/invalid.*occurred/i);
    await expect(store.recordApproval(issueApproval({
      id: "approval-invalid-issued",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:issued",
      issuedAt: "2026-02-30T00:00:00Z",
    }))).rejects.toThrow(/invalid.*issued/i);
    await expect(store.recordApproval(issueApproval({
      id: "approval-invalid-expiry",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:expiry",
      issuedAt: "2026-08-26T00:00:00Z",
      expiresAt: "2026-08-26T00:00:00+15:00",
    }))).rejects.toThrow(/invalid.*expiry/i);

    await store.recordApproval(issueApproval({
      id: "approval-valid",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:valid",
      issuedAt: "2026-08-26T00:00:00Z",
    }));
    await expect(
      store.consumeApproval(
        "approval-valid", "sha256:valid", "2026-08-26T00:01:00+15:00", 1, "policy_review",
      ),
    ).rejects.toThrow(/invalid.*consumed/i);
  });

  it("upserts Qodo findings without allowing fractional or stale iterations", async () => {
    const { database, store } = openMemoryStore();
    await store.create(campaign());
    await store.recordQodoFinding("campaign-1", 1, {
      id: "qodo-1",
      severity: "high",
      status: "open",
      summary: "Unsafe retry",
    });
    await store.recordQodoFinding("campaign-1", 2, {
      id: "qodo-1",
      severity: "low",
      status: "fixed",
      summary: "Retry guarded",
      disposition: "Fixed in tests",
    });

    expect((await store.get("campaign-1"))?.qodoFindings).toEqual([
      {
        id: "qodo-1",
        severity: "low",
        status: "fixed",
        summary: "Retry guarded",
        disposition: "Fixed in tests",
      },
    ]);
    await expect(
      store.recordQodoFinding("campaign-1", 1.5, {
        id: "qodo-2",
        severity: "low",
        status: "open",
        summary: "Out of bounds",
      }),
    ).rejects.toThrow(/integer.*iteration/i);
    await expect(store.recordQodoFinding("campaign-1", 1, {
      id: "qodo-1",
      severity: "high",
      status: "open",
      summary: "Stale finding",
    })).rejects.toThrow(/stale.*iteration/i);
    expect((await store.get("campaign-1"))?.qodoFindings[0]?.summary).toBe("Retry guarded");

    expect(() => database.prepare(
      "UPDATE campaigns SET qodo_iteration = 1.5 WHERE id = 'campaign-1'",
    ).run()).toThrow(/check constraint/i);
    expect(() => database.prepare(
      "UPDATE qodo_findings SET iteration = 1.5 WHERE id = 'qodo-1'",
    ).run()).toThrow(/check constraint/i);
  });

  it("rejects fractional campaign Qodo iteration through the adapter", async () => {
    const { store } = openMemoryStore();
    await expect(store.create(campaign({ qodoIteration: 1.5 }))).rejects.toThrow(
      /integer.*qodo iteration/i,
    );
  });

  it("deduplicates external references within a campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());
    const reference = { kind: "branch" as const, value: "openquest/fix" };

    await store.setExternalReference("campaign-1", reference);
    await store.setExternalReference("campaign-1", reference);

    expect((await store.get("campaign-1"))?.externalReferences).toEqual([reference]);
  });

  it("atomically replaces the singleton current commit while preserving multi-valued sessions", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());
    await store.replaceCurrentCommit("campaign-1", "a".repeat(40), 1, "policy_review");
    await store.setExternalReference("campaign-1", { kind: "child_session", value: "session-1" });
    await store.replaceCurrentCommit("campaign-1", "b".repeat(40), 2, "policy_review");
    await store.setExternalReference("campaign-1", { kind: "child_session", value: "session-2" });

    expect((await store.get("campaign-1"))?.externalReferences).toEqual([
      { kind: "child_session", value: "session-1" },
      { kind: "child_session", value: "session-2" },
      { kind: "commit", value: "b".repeat(40) },
    ]);
  });

  it("versions current-head replacement and rejects generic commit writes", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "implementation", version: 4 }));

    await expect(store.setExternalReference("campaign-1", { kind: "commit", value: "a".repeat(40) })).rejects.toThrow(/commit/i);
    await expect(store.replaceCurrentCommit("campaign-1", "a".repeat(40), 4, "implementation")).resolves.toBe(5);
    await expect(store.replaceCurrentCommit("campaign-1", "b".repeat(40), 4, "implementation")).rejects.toThrow(/version/i);
    expect((await store.get("campaign-1"))?.campaign.version).toBe(5);
    expect((await store.get("campaign-1"))?.externalReferences).toEqual([{ kind: "commit", value: "a".repeat(40) }]);
  });

  it("versions singleton pull-request identity and rejects generic pull-request writes", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "pull_request_open", version: 4 }));

    await expect(store.setExternalReference("campaign-1", {
      kind: "pull_request",
      value: "https://github.com/owner/repo/pull/7",
    })).rejects.toThrow(/pull request/i);
    await expect(store.replaceCurrentPullRequest(
      "campaign-1",
      "https://github.com/owner/repo/pull/7",
      4,
      "pull_request_open",
    )).resolves.toBe(5);
    await expect(store.replaceCurrentPullRequest(
      "campaign-1",
      "https://github.com/owner/repo/pull/8",
      4,
      "pull_request_open",
    )).rejects.toThrow(/version/i);
    expect((await store.get("campaign-1"))?.externalReferences).toEqual([
      { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" },
    ]);
  });

  it("atomically fences child result references, event, and commit against recovery", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "implementation", version: 4 }));
    const recovered = transitionCampaign(campaign({ status: "implementation", version: 4 }), "human_escalation");
    await store.update(recovered, 4);

    await expect(store.recordChildResult("campaign-1", {
      expectedVersion: 4,
      expectedStatus: "implementation",
      childSessionId: "late-child",
      event: { id: "late-event", eventType: "campaign_operation_completed", payload: { claimedCampaignVersion: 4 }, occurredAt: "2026-08-26T00:01:00Z" },
      newCommitSha: "b".repeat(40),
    })).rejects.toThrow(/version/i);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.externalReferences).toEqual([]);
    expect(snapshot?.events).toEqual([]);
  });

  it("records a child result and changed head as one versioned transaction", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "implementation", version: 4 }));
    const version = await store.recordChildResult("campaign-1", {
      expectedVersion: 4,
      expectedStatus: "implementation",
      childSessionId: "child-1",
      event: { id: "child-event", eventType: "campaign_operation_completed", payload: { claimedCampaignVersion: 4, resultingCampaignVersion: 5 }, occurredAt: "2026-08-26T00:01:00Z" },
      newCommitSha: "b".repeat(40),
      operationResult: { operation: "implement", currentCommitSha: "b".repeat(40), qodoIteration: 0 },
    });

    expect(version).toBe(5);
    expect((await store.get("campaign-1"))?.externalReferences).toEqual([
      { kind: "child_session", value: "child-1" },
      { kind: "commit", value: "b".repeat(40) },
      { kind: "sandbox", value: "child-1" },
    ]);
    expect((await store.get("campaign-1"))?.events).toHaveLength(1);
  });

  it("forbids generic repair-time rotation while the claimed child can atomically publish its commit", async () => {
    const { store, database } = openMemoryStore();
    await store.create(campaign({ status: "repair", version: 2, qodoIteration: 1 }));
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run("campaign-1", "https://github.com/owner/repo/pull/7");
    await expect(store.replaceCurrentCommit("campaign-1", "b".repeat(40), 2, "repair")).rejects.toThrow(/repair/i);
    const version = await store.recordChildResult("campaign-1", {
      expectedVersion: 2,
      expectedStatus: "repair",
      childSessionId: "repair-child",
      event: { id: "repair-completed", eventType: "campaign_operation_completed", payload: { claimedCampaignVersion: 2, resultingCampaignVersion: 3 }, occurredAt: "2026-08-26T00:01:00Z" },
      newCommitSha: "b".repeat(40),
      operationResult: { operation: "repair", currentCommitSha: "b".repeat(40), pullRequest: "https://github.com/owner/repo/pull/7", qodoIteration: 1 },
    });
    expect(version).toBe(3);
    expect((await store.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: "b".repeat(40) });
  });

  it("durably claims approval, frozen payload identity, and attempted evidence before blocking other connections", async () => {
    const { storeA, storeB, databaseA } = openTwoConnectionStore("openquest-external-claim-");
    await seedExternalActionCampaign(storeA, databaseA);
    const record = externalClaimRecord();
    await storeA.claimExternalAction("campaign-1", record);

    const claimed = await storeB.get("campaign-1");
    expect(claimed?.approvals[0]?.status).toBe("consumed");
    expect(claimed?.events.map(({ eventType }) => eventType)).toEqual(["external_action_attempted"]);
    expect(claimed?.externalActionClaims).toEqual([expect.objectContaining({ id: "claim-1", status: "active", payload: externalPayload })]);
    await expect(storeB.replaceCurrentCommit("campaign-1", "b".repeat(40), 7, "contribution_approval")).rejects.toThrow(/external action/i);
    await expect(storeB.recordChildResult("campaign-1", {
      expectedVersion: 7,
      expectedStatus: "contribution_approval",
      childSessionId: "late-child",
      event: { id: "late-child-event", eventType: "campaign_operation_completed", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 7 }, occurredAt: "2026-08-26T00:02:00Z" },
    })).rejects.toThrow(/external action/i);
    await storeB.recordApproval(issueApproval({ id: "approval-2", campaignId: "campaign-1", action: "create_pr", actionDigest: externalActionDigest(externalPayload), issuedAt: "2026-08-26T00:00:00Z" }));
    await expect(storeB.claimExternalAction("campaign-1", { ...externalClaimRecord(), claimId: "claim-2", approvalId: "approval-2", attemptedEvent: { ...externalClaimRecord().attemptedEvent, id: "attempt-2" } })).rejects.toThrow(/external action|unique/i);
  });

  it("rolls back approval consumption when attempted evidence prevents durable claim creation", async () => {
    const { storeA, databaseA } = openTwoConnectionStore("openquest-external-attempt-rollback-");
    await seedExternalActionCampaign(storeA, databaseA);
    databaseA.exec(`CREATE TRIGGER fail_external_attempt BEFORE INSERT ON campaign_events WHEN NEW.event_type = 'external_action_attempted' BEGIN SELECT RAISE(ABORT, 'attempt rejected'); END;`);
    await expect(storeA.claimExternalAction("campaign-1", externalClaimRecord())).rejects.toThrow(/attempt rejected/i);
    const snapshot = await storeA.get("campaign-1");
    expect(snapshot?.approvals[0]?.status).toBe("approved");
    expect(snapshot?.externalActionClaims).toEqual([]);
    expect(snapshot?.events).toEqual([]);
  });

  it("atomically completes the exact approved push, rotates head, and closes its claim", async () => {
    const { storeA, storeB, databaseA } = openTwoConnectionStore("openquest-external-complete-");
    const nextCommit = "b".repeat(40);
    const payload = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: nextCommit };
    await storeA.create(campaign({ status: "contribution_approval", version: 7 }));
    databaseA.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", "a".repeat(40));
    await storeA.recordApproval(issueApproval({ id: "approval-push", campaignId: "campaign-1", action: "push_branch", actionDigest: externalActionDigest(payload), issuedAt: "2026-08-26T00:00:00Z" }));
    await storeA.claimExternalAction("campaign-1", { ...externalClaimRecord(), approvalId: "approval-push", actionDigest: externalActionDigest(payload), payload });
    const version = await storeB.completeExternalAction("campaign-1", {
      claimId: "claim-1",
      completedAt: "2026-08-26T00:03:00Z",
      completedEvent: { id: "completed-push", eventType: "external_action_completed", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 8 }, occurredAt: "2026-08-26T00:03:00Z" },
      newCommitSha: nextCommit,
    });
    expect(version).toBe(8);
    const completed = await storeA.get("campaign-1");
    expect(completed?.externalActionClaims[0]?.status).toBe("completed");
    expect(completed?.externalReferences).toContainEqual({ kind: "commit", value: nextCommit });
    expect(completed?.campaign.version).toBe(8);
  });

  it("atomically rejects update_pr when its payload commit is not the current head", async () => {
    const { store, database } = openMemoryStore();
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: "b".repeat(40),
      body: "Publish reviewed repair",
    };
    await store.create(campaign({ status: "repair", version: 3, qodoIteration: 1 }));
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", "a".repeat(40));
    await store.recordApproval(issueApproval({ id: "approval-update", campaignId: "campaign-1", action: "update_pr", actionDigest: externalActionDigest(payload), issuedAt: "2026-08-26T00:00:00Z" }));

    await expect(store.claimExternalAction("campaign-1", {
      ...externalClaimRecord(),
      approvalId: "approval-update",
      actionDigest: externalActionDigest(payload),
      payload,
      expectedVersion: 3,
      expectedStatus: "repair",
      expectedCurrentCommitSha: "a".repeat(40),
      attemptedEvent: { ...externalClaimRecord().attemptedEvent, payload: { claimedCampaignVersion: 3, resultingCampaignVersion: 3 } },
    })).rejects.toThrow(/current campaign head/i);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("atomically claims update_pr only for the exact singleton PR and durable repair completion", async () => {
    const { store, database } = openMemoryStore();
    const currentHead = "c".repeat(40);
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: currentHead,
      body: "Publish reviewed repair",
    };
    await store.create(campaign({ status: "repair", version: 3, qodoIteration: 1 }));
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", currentHead);
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run("campaign-1", payload.pullRequest);
    insertRepairAuthority(database, { eventId: "repair-completed", currentHead, pullRequest: payload.pullRequest });
    await store.recordApproval(issueApproval({
      id: "approval-update",
      campaignId: "campaign-1",
      action: "update_pr",
      actionDigest: externalActionDigest(payload),
      issuedAt: "2026-08-26T00:00:00Z",
    }));

    await expect(store.claimExternalAction("campaign-1", {
      ...externalClaimRecord(),
      approvalId: "approval-update",
      actionDigest: externalActionDigest(payload),
      payload,
      expectedCurrentCommitSha: currentHead,
      expectedVersion: 3,
      expectedStatus: "repair",
      attemptedEvent: {
        ...externalClaimRecord().attemptedEvent,
        payload: { claimedCampaignVersion: 3, resultingCampaignVersion: 3 },
      },
    })).resolves.toMatchObject({ status: "active", payload });
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("consumed");
  });

  it.each([
    ["missing pull request", "missing_pr"],
    ["ambiguous pull request", "ambiguous_pr"],
    ["mismatched pull request", "mismatched_pr"],
    ["missing repair completion", "missing_event"],
    ["mismatched repair completion", "mismatched_event"],
    ["ambiguous repair completion", "ambiguous_event"],
  ] as const)("atomically rejects update_pr with %s without consuming approval", async (_label, scenario) => {
    const { store, database } = openMemoryStore();
    const currentHead = "c".repeat(40);
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: currentHead,
      body: "Publish reviewed repair",
    };
    await store.create(campaign({ status: "repair", version: 3, qodoIteration: 1 }));
    database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", currentHead);
    if (scenario !== "missing_pr") {
      database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run(
        "campaign-1",
        scenario === "mismatched_pr" ? "https://github.com/owner/repo/pull/8" : payload.pullRequest,
      );
    }
    if (scenario === "ambiguous_pr") {
      database.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run("campaign-1", "https://github.com/owner/repo/pull/8");
    }
    if (scenario !== "missing_event") {
      insertRepairAuthority(database, { eventId: "repair-completed-1", currentHead, pullRequest: payload.pullRequest, qodoIteration: scenario === "mismatched_event" ? 2 : 1 });
    }
    if (scenario === "ambiguous_event") {
      insertRepairAuthority(database, { eventId: "repair-completed-2", currentHead, pullRequest: payload.pullRequest });
    }
    await store.recordApproval(issueApproval({
      id: "approval-update",
      campaignId: "campaign-1",
      action: "update_pr",
      actionDigest: externalActionDigest(payload),
      issuedAt: "2026-08-26T00:00:00Z",
    }));

    await expect(store.claimExternalAction("campaign-1", {
      ...externalClaimRecord(),
      approvalId: "approval-update",
      actionDigest: externalActionDigest(payload),
      payload,
      expectedCurrentCommitSha: currentHead,
      expectedVersion: 3,
      expectedStatus: "repair",
      attemptedEvent: {
        ...externalClaimRecord().attemptedEvent,
        payload: { claimedCampaignVersion: 3, resultingCampaignVersion: 3 },
      },
    })).rejects.toThrow(/pull request|repair completion/i);
    const snapshot = await store.get("campaign-1");
    expect(snapshot?.approvals[0]?.status).toBe("approved");
    expect(snapshot?.externalActionClaims).toEqual([]);
    expect(snapshot?.events.filter(({ eventType }) => eventType === "external_action_attempted")).toEqual([]);
  });

  it("atomically fences a pull-request identity inserted between app validation and claim", async () => {
    const { storeA, databaseA, databaseB } = openTwoConnectionStore("openquest-update-pr-race-");
    const currentHead = "c".repeat(40);
    const payload = {
      action: "update_pr" as const,
      repository: "owner/repo",
      issueNumber: 42,
      pullRequest: "https://github.com/owner/repo/pull/7",
      branch: "openquest/fix-42",
      commitSha: currentHead,
      body: "Publish reviewed repair",
    };
    await storeA.create(campaign({ status: "repair", version: 3, qodoIteration: 1 }));
    databaseA.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", currentHead);
    databaseA.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run("campaign-1", payload.pullRequest);
    insertRepairAuthority(databaseA, { eventId: "repair-completed", currentHead, pullRequest: payload.pullRequest });
    await storeA.recordApproval(issueApproval({
      id: "approval-update",
      campaignId: "campaign-1",
      action: "update_pr",
      actionDigest: externalActionDigest(payload),
      issuedAt: "2026-08-26T00:00:00Z",
    }));
    let raced = false;
    const racingStore = new Proxy(storeA, {
      get(target, property) {
        if (property === "claimExternalAction") {
          return async (campaignId: string, record: ExternalActionClaimRecord) => {
            if (!raced) {
              raced = true;
              databaseB.transaction(() => {
                databaseB.prepare("DELETE FROM external_references WHERE campaign_id = ? AND kind = 'pull_request'").run(campaignId);
                databaseB.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'pull_request', ?)").run(campaignId, "https://github.com/owner/repo/pull/8");
              }).immediate();
            }
            return target.claimExternalAction(campaignId, record);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        // The proxy binds private-field methods back to their concrete adapter.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as CampaignStore;
    let eventNumber = 0;
    const runner = new RunCampaign(
      racingStore,
      new FakeHarness(),
      { now: () => "2026-08-26T00:01:00Z" },
      { next: () => `race-event-${String(++eventNumber)}` },
    );
    const callback = vi.fn(async () => undefined);

    await expect(runner.executeApprovedExternalAction(
      "campaign-1",
      { approvalId: "approval-update", payload },
      callback,
    )).rejects.toThrow(/pull request/i);
    expect(callback).not.toHaveBeenCalled();
    const snapshot = await storeA.get("campaign-1");
    expect(snapshot?.approvals[0]?.status).toBe("approved");
    expect(snapshot?.externalActionClaims).toEqual([]);
    expect(snapshot?.events.filter(({ eventType }) => eventType === "external_action_attempted")).toEqual([]);
  });

  it("rolls back duplicate multi-connection claims and leaves exactly one consumed approval", async () => {
    const { storeA, storeB, databaseA } = openTwoConnectionStore("openquest-external-duplicate-");
    await seedExternalActionCampaign(storeA, databaseA);
    const results = await Promise.allSettled([
      storeA.claimExternalAction("campaign-1", externalClaimRecord()),
      storeB.claimExternalAction("campaign-1", { ...externalClaimRecord(), claimId: "claim-2", attemptedEvent: { ...externalClaimRecord().attemptedEvent, id: "attempt-2" } }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect((await storeA.get("campaign-1"))?.externalActionClaims).toHaveLength(1);
    expect((await storeA.get("campaign-1"))?.approvals[0]?.status).toBe("consumed");
  });

  it("compensates completion uncertainty to outcome unknown and reconciles without reusing approval", async () => {
    const { storeA, storeB, databaseA } = openTwoConnectionStore("openquest-external-reconcile-");
    await seedExternalActionCampaign(storeA, databaseA);
    await storeA.claimExternalAction("campaign-1", externalClaimRecord());
    databaseA.exec(`CREATE TRIGGER fail_external_completion BEFORE INSERT ON campaign_events WHEN NEW.event_type = 'external_action_completed' BEGIN SELECT RAISE(ABORT, 'completion uncertain'); END;`);
    await expect(storeA.completeExternalAction("campaign-1", {
      claimId: "claim-1",
      completedAt: "2026-08-26T00:03:00Z",
      completedEvent: { id: "completed-1", eventType: "external_action_completed", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 7 }, occurredAt: "2026-08-26T00:03:00Z" },
    })).rejects.toThrow(/completion uncertain/i);
    await storeA.markExternalActionOutcomeUnknown("campaign-1", {
      claimId: "claim-1",
      event: { id: "unknown-1", eventType: "external_action_outcome_unknown", payload: { claimId: "claim-1", reason: "external_action_result_unknown" }, occurredAt: "2026-08-26T00:04:00Z" },
    });
    await expect(storeB.replaceCurrentCommit("campaign-1", "b".repeat(40), 7, "contribution_approval")).rejects.toThrow(/external action/i);
    await expect(storeB.reconcileExternalAction("campaign-1", {
      claimId: "stale-claim",
      disposition: "confirmed_completed",
      reconciledAt: "2026-08-26T00:05:00Z",
      event: { id: "stale-reconcile", eventType: "external_action_reconciled", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 8 }, occurredAt: "2026-08-26T00:05:00Z" },
      observedCanonicalHead: "b".repeat(40),
    })).rejects.toThrow(/claim/i);
    const version = await storeB.reconcileExternalAction("campaign-1", {
      claimId: "claim-1",
      disposition: "confirmed_completed",
      reconciledAt: "2026-08-26T00:05:00Z",
      event: { id: "reconcile-1", eventType: "external_action_reconciled", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 8 }, occurredAt: "2026-08-26T00:05:00Z" },
      observedCanonicalHead: "b".repeat(40),
    });
    expect(version).toBe(8);
    const reconciled = await storeA.get("campaign-1");
    expect(reconciled?.externalActionClaims[0]).toMatchObject({ status: "reconciled", disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40) });
    expect(reconciled?.approvals[0]?.status).toBe("consumed");
    await expect(storeA.claimExternalAction("campaign-1", { ...externalClaimRecord(), claimId: "claim-reuse", expectedVersion: 8, expectedCurrentCommitSha: "b".repeat(40), attemptedEvent: { ...externalClaimRecord().attemptedEvent, id: "attempt-reuse", payload: { claimedCampaignVersion: 8, resultingCampaignVersion: 8 } } })).rejects.toThrow(/approval|unique|current campaign head/i);
  });

  it("recovers a persisted stale active claim after restart, rejects late completion, and reconciles without restoring approval", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openquest-stale-claim-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "campaigns.sqlite");
    const firstDatabase = new Database(databasePath);
    databases.push(firstDatabase);
    const firstStore = new SqliteCampaignStore(firstDatabase);
    const nextCommit = "b".repeat(40);
    const pushPayload = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: nextCommit };
    await firstStore.create(campaign({ status: "contribution_approval", version: 7 }));
    firstDatabase.prepare("INSERT INTO external_references (campaign_id, kind, value) VALUES (?, 'commit', ?)").run("campaign-1", "a".repeat(40));
    await firstStore.recordApproval(issueApproval({ id: "approval-push", campaignId: "campaign-1", action: "push_branch", actionDigest: externalActionDigest(pushPayload), issuedAt: "2026-08-26T00:00:00Z" }));
    await firstStore.claimExternalAction("campaign-1", { ...externalClaimRecord(), approvalId: "approval-push", actionDigest: externalActionDigest(pushPayload), payload: pushPayload });
    firstDatabase.close();

    const secondDatabase = new Database(databasePath);
    databases.push(secondDatabase);
    const secondStore = new SqliteCampaignStore(secondDatabase);
    let eventNumber = 0;
    const freshService = (now: string) => new RunCampaign(
      secondStore,
      new FakeHarness(),
      { now: () => now },
      { next: () => `restart-event-${String(++eventNumber)}` },
      { externalActionClaimStaleAfterMs: 5 * 60_000 },
    );
    await expect(freshService("2026-08-26T00:03:00Z").recoverStaleExternalAction("campaign-1", { claimId: "claim-1", disposition: "operator checked process state" })).rejects.toMatchObject({ code: "invalid_transition" });
    const active = await secondStore.get("campaign-1");
    expect(active?.externalActionClaims[0]?.status).toBe("active");
    expect(active?.events.map(({ eventType }) => eventType)).toEqual(["external_action_attempted"]);
    const restartedService = freshService("2026-08-26T00:10:00Z");
    await expect(restartedService.recoverStaleExternalAction("campaign-1", { claimId: "claim-1", disposition: "operator confirmed original process is gone" })).resolves.toMatchObject({ status: "contribution_approval" });
    const unknown = await secondStore.get("campaign-1");
    expect(unknown?.externalActionClaims[0]).toMatchObject({ status: "outcome_unknown", leaseStartedAt: "2026-08-26T00:01:00.000Z" });
    expect(unknown?.approvals[0]?.status).toBe("consumed");

    await expect(secondStore.completeExternalAction("campaign-1", {
      claimId: "claim-1",
      completedAt: "2026-08-26T00:11:00Z",
      completedEvent: { id: "late-completion", eventType: "external_action_completed", payload: { claimedCampaignVersion: 7, resultingCampaignVersion: 8 }, occurredAt: "2026-08-26T00:11:00Z" },
      newCommitSha: nextCommit,
    })).rejects.toThrow(/not active/i);
    expect((await secondStore.get("campaign-1"))?.events).toEqual(unknown?.events);
    expect((await secondStore.get("campaign-1"))?.externalReferences).toContainEqual({ kind: "commit", value: "a".repeat(40) });

    await expect(restartedService.reconcileExternalAction("campaign-1", { claimId: "claim-1", disposition: "confirmed_not_completed" })).resolves.toMatchObject({ status: "contribution_approval" });
    const reconciled = await secondStore.get("campaign-1");
    if (reconciled === undefined) throw new Error("missing reconciled campaign");
    expect(reconciled.externalActionClaims[0]?.status).toBe("reconciled");
    expect(reconciled.approvals[0]?.status).toBe("consumed");
    await expect(secondStore.update(transitionCampaign(reconciled.campaign, "pull_request_open"), reconciled.campaign.version)).resolves.toBeUndefined();
  });

  it("upgrades existing external-reference tables to retain commit identity", async () => {
    const { database, store } = openMemoryStore();
    await store.create(campaign());
    await store.setExternalReference("campaign-1", { kind: "branch", value: "openquest/fix" });
    database.exec(`
      ALTER TABLE external_references RENAME TO external_references_current;
      CREATE TABLE external_references (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'branch', 'pull_request', 'sandbox', 'child_session', 'ci_run')),
        value TEXT NOT NULL,
        PRIMARY KEY (campaign_id, kind, value)
      );
      INSERT INTO external_references SELECT * FROM external_references_current;
      DROP TABLE external_references_current;
    `);

    const migrated = new SqliteCampaignStore(database);
    await migrated.replaceCurrentCommit("campaign-1", "d".repeat(40), 1, "policy_review");

    expect((await migrated.get("campaign-1"))?.externalReferences).toEqual([
      { kind: "branch", value: "openquest/fix" },
      { kind: "commit", value: "d".repeat(40) },
    ]);
  });

  it("enforces foreign keys for all child memory", async () => {
    const { store } = openMemoryStore();

    await expect(store.appendEvidence("missing-campaign", evidence())).rejects.toThrow(
      /foreign key constraint/i,
    );
  });

  it("persists approval expiry and consumption after reopening the database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openquest-campaign-store-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "campaigns.sqlite");
    const firstDatabase = new Database(databasePath);
    databases.push(firstDatabase);
    const firstStore = new SqliteCampaignStore(firstDatabase);
    await firstStore.create(campaign({ status: "contribution_approval" }));
    await firstStore.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:exact",
      issuedAt: "2026-08-26T00:00:00Z",
      expiresAt: "2026-08-26T01:00:00Z",
    }));
    firstDatabase.close();

    const secondDatabase = new Database(databasePath);
    databases.push(secondDatabase);
    const secondStore = new SqliteCampaignStore(secondDatabase);
    expect((await secondStore.get("campaign-1"))?.approvals[0]).toMatchObject({
      issuedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T01:00:00.000Z",
    });
    const consumed = await secondStore.consumeApproval(
      "approval-1",
      "sha256:exact",
      "2026-08-26T00:30:00Z",
      1,
      "contribution_approval",
    );
    expect(consumed).toMatchObject({
      status: "consumed",
      consumedAt: "2026-08-26T00:30:00.000Z",
    });
    secondDatabase.close();

    const thirdDatabase = new Database(databasePath);
    databases.push(thirdDatabase);
    const thirdStore = new SqliteCampaignStore(thirdDatabase);
    expect((await thirdStore.get("campaign-1"))?.approvals[0]).toMatchObject({
      status: "consumed",
      consumedAt: "2026-08-26T00:30:00.000Z",
      expiresAt: "2026-08-26T01:00:00.000Z",
    });
  });

  it("allows exactly one consumer when two stale callers use the same approval", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openquest-approval-race-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "campaigns.sqlite");
    const databaseA = new Database(databasePath);
    const databaseB = new Database(databasePath);
    databases.push(databaseA, databaseB);
    const storeA = new SqliteCampaignStore(databaseA);
    const storeB = new SqliteCampaignStore(databaseB);
    await storeA.create(campaign({ status: "contribution_approval" }));
    await storeA.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "push_branch",
      actionDigest: "sha256:payload",
      issuedAt: "2026-08-26T00:00:00Z",
      expiresAt: "2026-08-26T01:00:00Z",
    }));

    const staleReadA = (await storeA.get("campaign-1"))?.approvals[0];
    const staleReadB = (await storeB.get("campaign-1"))?.approvals[0];
    expect(staleReadA).toEqual(staleReadB);
    const results = await Promise.allSettled([
      storeA.consumeApproval(
        "approval-1", "sha256:payload", "2026-08-26T00:10:00Z", 1, "contribution_approval",
      ),
      storeB.consumeApproval(
        "approval-1", "sha256:payload", "2026-08-26T00:10:00Z", 1, "contribution_approval",
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await storeB.get("campaign-1"))?.approvals[0]?.status).toBe("consumed");
  });

  it("atomically rejects approval when campaign version or allowed status changed", async () => {
    const { store } = openMemoryStore();
    const original = campaign({ status: "contribution_approval", version: 7 });
    await store.create(original);
    await store.recordApproval(issueApproval({
      id: "approval-state-cas",
      campaignId: original.id,
      action: "create_pr",
      actionDigest: "sha256:state-cas",
      issuedAt: "2026-08-26T00:00:00Z",
    }));
    const withdrawn = { ...original, status: "withdrawn" as const, version: 8 };
    await store.update(withdrawn, 7);

    await expect(store.consumeApproval(
      "approval-state-cas",
      "sha256:state-cas",
      "2026-08-26T00:01:00Z",
      7,
      "contribution_approval",
    )).rejects.toThrow(/version|state/i);
    expect((await store.get(original.id))?.approvals[0]?.status).toBe("approved");

    const quarantined = campaign({
      id: "campaign-quarantined",
      repository: "owner/quarantined",
      issueNumber: 43,
      status: "quarantined",
    });
    await store.create(quarantined);
    await store.recordApproval(issueApproval({
      id: "approval-quarantined",
      campaignId: quarantined.id,
      action: "create_pr",
      actionDigest: "sha256:quarantined",
      issuedAt: "2026-08-26T00:00:00Z",
    }));
    await expect(store.consumeApproval(
      "approval-quarantined",
      "sha256:quarantined",
      "2026-08-26T00:01:00Z",
      1,
      "quarantined",
    )).rejects.toThrow(/state/i);
    expect((await store.get(quarantined.id))?.approvals[0]?.status).toBe("approved");
  });

  it("rejects a digest mismatch without consuming the approval", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "contribution_approval" }));
    await store.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:expected",
      issuedAt: "2026-08-26T00:00:00Z",
    }));

    await expect(
      store.consumeApproval(
        "approval-1", "sha256:different", "2026-08-26T00:01:00Z", 1, "contribution_approval",
      ),
    ).rejects.toThrow(/does not match/i);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("rejects an approval at its exact expiry instant", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ status: "contribution_approval" }));
    await store.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:expected",
      issuedAt: "2026-08-26T00:00:00Z",
      expiresAt: "2026-08-26T00:05:00+00:00",
    }));

    await expect(
      store.consumeApproval(
        "approval-1", "sha256:expected", "2026-08-26T00:05:00Z", 1, "contribution_approval",
      ),
    ).rejects.toThrow(/expired/i);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("surfaces SQLITE_BUSY without consuming while another writer holds the lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openquest-approval-busy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "campaigns.sqlite");
    const lockDatabase = new Database(databasePath);
    const consumerDatabase = new Database(databasePath);
    databases.push(lockDatabase, consumerDatabase);
    consumerDatabase.pragma("busy_timeout = 0");
    const lockStore = new SqliteCampaignStore(lockDatabase);
    const consumerStore = new SqliteCampaignStore(consumerDatabase);
    await lockStore.create(campaign({ status: "contribution_approval" }));
    await lockStore.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:busy",
      issuedAt: "2026-08-26T00:00:00Z",
    }));

    lockDatabase.exec("BEGIN IMMEDIATE");
    await expect(
      consumerStore.consumeApproval(
        "approval-1", "sha256:busy", "2026-08-26T00:01:00Z", 1, "contribution_approval",
      ),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    expect((await consumerStore.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
    lockDatabase.exec("ROLLBACK");

    await expect(
      consumerStore.consumeApproval(
        "approval-1", "sha256:busy", "2026-08-26T00:01:00Z", 1, "contribution_approval",
      ),
    ).resolves.toMatchObject({ status: "consumed" });
  });

  it("fails construction when foreign keys cannot be enabled", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.pragma("foreign_keys = OFF");
    database.exec("BEGIN");

    expect(() => new SqliteCampaignStore(database)).toThrow(/foreign key enforcement/i);
    database.exec("ROLLBACK");
  });

  it("accepts enabled foreign keys when SQLite safe integers return 1n", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.defaultSafeIntegers(true);

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(() => new SqliteCampaignStore(database)).not.toThrow();
  });
});
