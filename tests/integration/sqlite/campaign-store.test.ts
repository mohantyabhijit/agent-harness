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
  it("never returns evidence from another issue campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a", issueNumber: 1 }));
    await store.create(campaign({ id: "campaign-b", issueNumber: 2 }));
    await store.appendEvidence("campaign-a", evidence({ id: "evidence-a" }));

    expect((await store.get("campaign-b"))?.evidence).toEqual([]);
  });

  it("enforces one campaign per repository issue and can find that campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a" }));

    await expect(store.create(campaign({ id: "campaign-b" }))).rejects.toThrow(/unique constraint/i);
    expect((await store.findByIssue("owner/repo", 42))?.campaign.id).toBe("campaign-a");
  });

  it("rejects a stale optimistic update without replacing the current campaign", async () => {
    const { store } = openMemoryStore();
    const original = campaign();
    await store.create(original);
    await store.update({ ...original, status: "preflight", version: 2 }, 1);

    await expect(
      store.update({ ...original, status: "withdrawn", version: 2 }, 1),
    ).rejects.toBeInstanceOf(CampaignVersionConflict);
    expect((await store.get(original.id))?.campaign).toMatchObject({
      status: "preflight",
      version: 2,
    });
  });

  it("returns campaigns by status without crossing status boundaries", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign({ id: "campaign-a", issueNumber: 1, status: "preflight" }));
    await store.create(campaign({ id: "campaign-b", issueNumber: 2, status: "policy_review" }));

    expect((await store.listByStatus("preflight")).map(({ campaign: item }) => item.id)).toEqual([
      "campaign-a",
    ]);
  });

  it("orders events deterministically and rejects malformed persisted JSON", async () => {
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
      occurredAt: "2026-08-26T00:30:00+01:00",
    });

    expect((await store.get("campaign-1"))?.events.map((event) => event.id)).toEqual([
      "event-earlier",
      "event-later",
    ]);

    database.prepare("UPDATE campaign_events SET payload_json = ? WHERE id = ?").run("{", "event-later");
    await expect(store.get("campaign-1")).rejects.toThrow(/invalid payload json.*event-later/i);
  });

  it("upserts Qodo findings and enforces iteration bounds", async () => {
    const { store } = openMemoryStore();
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
      store.recordQodoFinding("campaign-1", 4, {
        id: "qodo-2",
        severity: "low",
        status: "open",
        summary: "Out of bounds",
      }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("deduplicates external references within a campaign", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());
    const reference = { kind: "branch" as const, value: "openquest/fix" };

    await store.setExternalReference("campaign-1", reference);
    await store.setExternalReference("campaign-1", reference);

    expect((await store.get("campaign-1"))?.externalReferences).toEqual([reference]);
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
    await firstStore.create(campaign());
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
    expect((await secondStore.get("campaign-1"))?.approvals[0]?.expiresAt).toBe(
      "2026-08-26T01:00:00Z",
    );
    const consumed = await secondStore.consumeApproval(
      "approval-1",
      "sha256:exact",
      "2026-08-26T00:30:00Z",
    );
    expect(consumed).toMatchObject({
      status: "consumed",
      consumedAt: "2026-08-26T00:30:00Z",
    });
    secondDatabase.close();

    const thirdDatabase = new Database(databasePath);
    databases.push(thirdDatabase);
    const thirdStore = new SqliteCampaignStore(thirdDatabase);
    expect((await thirdStore.get("campaign-1"))?.approvals[0]).toMatchObject({
      status: "consumed",
      consumedAt: "2026-08-26T00:30:00Z",
      expiresAt: "2026-08-26T01:00:00Z",
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
    await storeA.create(campaign());
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
      storeA.consumeApproval("approval-1", "sha256:payload", "2026-08-26T00:10:00Z"),
      storeB.consumeApproval("approval-1", "sha256:payload", "2026-08-26T00:10:00Z"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await storeB.get("campaign-1"))?.approvals[0]?.status).toBe("consumed");
  });

  it("rejects a digest mismatch without consuming the approval", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());
    await store.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:expected",
      issuedAt: "2026-08-26T00:00:00Z",
    }));

    await expect(
      store.consumeApproval("approval-1", "sha256:different", "2026-08-26T00:01:00Z"),
    ).rejects.toThrow(/does not match/i);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });

  it("rejects an approval at its exact expiry instant", async () => {
    const { store } = openMemoryStore();
    await store.create(campaign());
    await store.recordApproval(issueApproval({
      id: "approval-1",
      campaignId: "campaign-1",
      action: "create_pr",
      actionDigest: "sha256:expected",
      issuedAt: "2026-08-26T00:00:00Z",
      expiresAt: "2026-08-26T00:05:00+00:00",
    }));

    await expect(
      store.consumeApproval("approval-1", "sha256:expected", "2026-08-26T00:05:00Z"),
    ).rejects.toThrow(/expired/i);
    expect((await store.get("campaign-1"))?.approvals[0]?.status).toBe("approved");
  });
});
