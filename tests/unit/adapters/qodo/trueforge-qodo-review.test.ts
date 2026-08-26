import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { TrueForgeQodoReview } from "../../../../src/adapters/qodo/trueforge-qodo-review.js";
import { HarnessOutputInvalid } from "../../../../src/application/ports/harness.js";
import type { QodoReviewAuthorityPort, QodoReviewCandidate, QodoReviewLocator } from "../../../../src/application/ports/qodo-review.js";
import { FakeHarness } from "../../../fakes/fake-harness.js";

const commitSha = "b".repeat(40);
const passFixture = await loadFixture("pass.json");

describe("TrueForgeQodoReview", () => {
  it("runs a fresh sync_qodo child with a campaign-bound, session-safe packet", async () => {
    const fixture = await loadFixture("actionable.json");
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "Qodo review synchronized", artifacts: [], output: locator(fixture) });
    const review = new TrueForgeQodoReview(harness, new FakeAuthority(fixture as unknown as QodoReviewCandidate), { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });
    const controller = new AbortController();

    await expect(review.getReview("owner/repo", 7, {
      packet: campaignPacket(),
      signal: controller.signal,
      timeoutMs: 500,
    })).resolves.toMatchObject({
      syncSessionId: "session-1",
      reviewId: "qodo-review-actionable-1",
      commitSha,
      testsPassed: true,
      complete: true,
      findings: [
        expect.objectContaining({ id: "comment-101", severity: "high" }),
        expect.objectContaining({ id: "comment-102", severity: "suggestion" }),
      ],
    });
    expect(harness.childSessions).toHaveLength(1);
    expect(harness.operations).toEqual(["sync_qodo"]);
    expect(harness.requestOptions).toEqual([{ signal: controller.signal, timeoutMs: 500 }]);
    expect(harness.packets[0]).toEqual(expect.objectContaining({
      campaignId: "campaign-1",
      repository: "owner/repo",
      issueNumber: 42,
      currentCommitSha: commitSha,
      context: expect.objectContaining({
        pullRequest: "https://github.com/owner/repo/pull/7",
        pullRequestNumber: 7,
        commitSha,
        allowedAuthors: ["qodo-merge-pro[bot]"],
        responseContract: "qodo_review_locator_v1",
      }),
    }));
    expect(harness.packets[0]?.context?.responseSchema).toMatchObject({
      additionalProperties: false,
      required: ["schemaVersion", "reviewUrl", "sourceReceipt"],
      fields: expect.objectContaining({ sourceReceipt: expect.objectContaining({ semantics: expect.stringContaining("authority") }) }),
    });
    const responseSchema = harness.packets[0]?.context?.responseSchema as { fields?: Record<string, unknown> } | undefined;
    expect(Object.keys(responseSchema?.fields ?? {}).sort()).toEqual(["reviewUrl", "schemaVersion", "sourceReceipt"]);
    expect(JSON.stringify(responseSchema)).not.toMatch(/testsPassed|complete|comments|sourceIdentity|commitSha/u);
  });

  it.each([
    ["malformed output", { reviewId: "review-only" }],
    ["unavailable-shaped output", { error: "qodo_unavailable" }],
    ["cross repository output", { ...locator(passFixture), reviewUrl: "https://github.com/attacker/repo/pull/7#pullrequestreview-1" }],
    ["non-numeric review locator", { ...locator(passFixture), reviewUrl: "https://github.com/owner/repo/pull/7#pullrequestreview-attacker" }],
    ["transformed receipt", { ...locator(passFixture), sourceReceipt: ` ${String(passFixture.sourceReceipt)} ` }],
    ["extra fact output", { ...locator(passFixture), commitSha: "c".repeat(40) }],
    ["oversized output", { ...locator(passFixture), sourceReceipt: "x".repeat(513) }],
  ])("rejects %s before findings can reach the quality gate", async (_label, output) => {
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "untrusted", artifacts: [], output });
    const review = new TrueForgeQodoReview(harness, new FakeAuthority(passFixture as unknown as QodoReviewCandidate), { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });

    await expect(review.getReview("owner/repo", 7, { packet: campaignPacket() })).rejects.toBeInstanceOf(HarnessOutputInvalid);
  });

  it("uses authenticated authority fields when the child forges gate state", async () => {
    const child = locator(passFixture);
    const authenticated = {
      ...passFixture,
      testsPassed: false,
      complete: false,
      comments: [{
        id: 901, html_url: "https://github.com/owner/repo/pull/7#discussion_r901",
        body: "**Severity:** High\nAuthenticated issue", path: "src/auth.ts", line: 9,
        user: { login: "qodo-merge-pro[bot]" }, status: "open",
      }],
    } as unknown as QodoReviewCandidate;
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "locator", artifacts: [], output: child });
    const review = new TrueForgeQodoReview(harness, new FakeAuthority(authenticated), { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });

    await expect(review.getReview("owner/repo", 7, { packet: campaignPacket() })).resolves.toMatchObject({
      testsPassed: false,
      complete: false,
      findings: [expect.objectContaining({ id: "comment-901", severity: "high" })],
    });
  });

  it("rejects a forged receipt that does not match authenticated GitHub evidence", async () => {
    const child = { ...locator(passFixture), sourceReceipt: "forged-child-receipt-999" };
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "forged receipt", artifacts: [], output: child });
    const review = new TrueForgeQodoReview(harness, new FakeAuthority(passFixture as unknown as QodoReviewCandidate), { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });

    await expect(review.getReview("owner/repo", 7, { packet: campaignPacket() })).rejects.toBeInstanceOf(HarnessOutputInvalid);
  });

  it("keeps a non-Qodo authenticated high finding from silently passing", async () => {
    const candidate = {
      ...passFixture,
      comments: [{
        id: 902, html_url: "https://github.com/owner/repo/pull/7#discussion_r902",
        body: "**Severity:** High\nHuman reviewer blocker", path: "src/review.ts", line: 1,
        user: { login: "maintainer" }, status: "open",
      }],
    } as unknown as QodoReviewCandidate;
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "review", artifacts: [], output: locator(candidate as unknown as Record<string, unknown>) });
    const review = new TrueForgeQodoReview(harness, new FakeAuthority(candidate), { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });

    await expect(review.getReview("owner/repo", 7, { packet: campaignPacket() })).resolves.toMatchObject({ complete: false, findings: [] });
  });

  it("requires an explicit non-empty Qodo identity allowlist", () => {
    expect(() => new TrueForgeQodoReview(new FakeHarness(), new FakeAuthority(passFixture as unknown as QodoReviewCandidate), { allowlistedBotIdentities: [] })).toThrow(/allowlist/i);
  });
});

class FakeAuthority implements QodoReviewAuthorityPort {
  constructor(private readonly canonical: QodoReviewCandidate) {}
  isAvailable(): boolean { return true; }
  async resolve(): Promise<QodoReviewCandidate> { return structuredClone(this.canonical); }
}

function locator(fixture: Record<string, unknown>): QodoReviewLocator {
  return {
    schemaVersion: "qodo_review_locator_v1",
    reviewUrl: String(fixture.reviewUrl),
    sourceReceipt: String(fixture.sourceReceipt),
  };
}

function campaignPacket() {
  return {
    campaignId: "campaign-1",
    repository: "owner/repo",
    issueNumber: 42,
    goal: "Synchronize Qodo",
    verifiedEvidence: [{ sourceUrl: "https://github.com/owner/repo/issues/42", observation: "Issue is open" }],
    approvals: [{ action: "create_pr", digest: "sha256:approved", status: "consumed" }],
    currentCommitSha: commitSha,
    context: { untrusted: "must-not-cross-the-adapter-boundary" },
  } as const;
}

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const contents = await readFile(new URL(`../../../../fixtures/qodo/${name}`, import.meta.url), "utf8");
  return JSON.parse(contents) as Record<string, unknown>;
}
