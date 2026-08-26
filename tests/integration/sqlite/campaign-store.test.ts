import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteCampaignStore } from "../../../src/adapters/sqlite/campaign-store.js";
import { CampaignVersionConflict } from "../../../src/application/ports/campaign-store.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { campaign, evidence } from "../../builders.js";

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

describe("SqliteCampaignStore", () => {
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
    await migrated.setExternalReference("campaign-1", { kind: "commit", value: "d".repeat(40) });

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
