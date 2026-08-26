import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { TrueForgeQodoReview } from "../../../../src/adapters/qodo/trueforge-qodo-review.js";
import { HarnessOutputInvalid } from "../../../../src/application/ports/harness.js";
import { FakeHarness } from "../../../fakes/fake-harness.js";

const commitSha = "b".repeat(40);
const passFixture = await loadFixture("pass.json");

describe("TrueForgeQodoReview", () => {
  it("runs a fresh sync_qodo child with a campaign-bound, session-safe packet", async () => {
    const fixture = await loadFixture("actionable.json");
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "Qodo review synchronized", artifacts: [], output: fixture });
    const review = new TrueForgeQodoReview(harness, { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });
    const controller = new AbortController();

    await expect(review.getReview("owner/repo", 7, {
      packet: campaignPacket(),
      signal: controller.signal,
      timeoutMs: 500,
    })).resolves.toMatchObject({
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
      context: {
        pullRequest: "https://github.com/owner/repo/pull/7",
        pullRequestNumber: 7,
        commitSha,
        allowedAuthors: ["qodo-merge-pro[bot]"],
        responseContract: "qodo_github_review_v1",
      },
    }));
  });

  it.each([
    ["malformed output", { reviewId: "review-only" }],
    ["unavailable-shaped output", { error: "qodo_unavailable" }],
    ["cross repository output", { ...passFixture, repository: "attacker/repo" }],
    ["stale commit output", { ...passFixture, commitSha: "c".repeat(40) }],
    ["oversized output", { ...passFixture, comments: Array.from({ length: 1_001 }, () => ({})) }],
  ])("rejects %s before findings can reach the quality gate", async (_label, output) => {
    const harness = new FakeHarness();
    harness.enqueueResult("sync_qodo", { summary: "untrusted", artifacts: [], output });
    const review = new TrueForgeQodoReview(harness, { allowlistedBotIdentities: ["qodo-merge-pro[bot]"] });

    await expect(review.getReview("owner/repo", 7, { packet: campaignPacket() })).rejects.toBeInstanceOf(HarnessOutputInvalid);
  });
});

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
