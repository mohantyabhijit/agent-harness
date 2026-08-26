import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseQodoReviewComments } from "../../../../src/adapters/qodo/github-review-parser.js";

const parserOptions = {
  repository: "owner/repo",
  pullRequestNumber: 7,
  allowlistedBotIdentities: ["qodo-merge-pro[bot]"],
} as const;

describe("parseQodoReviewComments", () => {
  it("normalizes explicit severity and preserves bounded source evidence", async () => {
    const fixture = await loadFixture("actionable.json");

    expect(parseQodoReviewComments(fixture.comments, parserOptions)).toEqual([
      {
        id: "comment-101",
        severity: "high",
        status: "open",
        summary: "The retry can issue the write twice after a timeout.",
        sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r101",
        body: "**Severity:** High\nThe retry can issue the write twice after a timeout.",
        path: "src/application/retry.ts",
        line: 42,
      },
      {
        id: "comment-102",
        severity: "suggestion",
        status: "open",
        summary: "This alarming race could be catastrophic, but no severity was assigned.",
        sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r102",
        body: "This alarming race could be catastrophic, but no severity was assigned.",
        path: "src/application/retry.ts",
        line: 51,
      },
    ]);
  });

  it("deduplicates identical Qodo comments by GitHub comment ID", async () => {
    const fixture = await loadFixture("duplicate.json");

    expect(parseQodoReviewComments(fixture.comments, parserOptions)).toHaveLength(1);
  });

  it("preserves a dismissed finding only with its technical disposition", async () => {
    const fixture = await loadFixture("subjective.json");

    expect(parseQodoReviewComments(fixture.comments, parserOptions)).toEqual([
      expect.objectContaining({
        id: "comment-201",
        severity: "low",
        status: "dismissed",
        disposition: "The broader refactor is outside the issue contract and adds unrelated risk.",
      }),
    ]);
  });

  it.each([
    ["unknown fields", { extra: "credential-bearing provider metadata" }],
    ["oversized bodies", { body: "x".repeat(20_001) }],
    ["cross-pull-request URLs", { html_url: "https://github.com/owner/repo/pull/8#discussion_r101" }],
    ["unsafe paths", { path: "../secrets.txt" }],
    ["invalid lines", { line: 0 }],
    ["dismissals without rationale", { status: "dismissed", disposition: undefined }],
  ])("fails closed for malformed allowlisted comments: %s", async (_label, replacement) => {
    const fixture = await loadFixture("actionable.json");
    const [first] = fixture.comments;
    if (first === undefined) throw new Error("Missing actionable fixture comment");
    const malformed: Record<string, unknown> = { ...first, ...replacement };
    if ("disposition" in replacement) delete malformed.disposition;

    expect(() => parseQodoReviewComments([malformed], parserOptions)).toThrow();
  });

  it("rejects conflicting duplicate IDs instead of accepting whichever comment arrives first", async () => {
    const fixture = await loadFixture("duplicate.json");
    const [first] = fixture.comments;
    if (first === undefined) throw new Error("Missing duplicate fixture comment");

    expect(() => parseQodoReviewComments([
      first,
      { ...first, body: "**Severity:** Low\nConflicting content for the same comment." },
    ], parserOptions)).toThrow();
  });
});

interface ReviewFixture {
  readonly comments: readonly Record<string, unknown>[];
}

async function loadFixture(name: string): Promise<ReviewFixture> {
  const contents = await readFile(new URL(`../../../../fixtures/qodo/${name}`, import.meta.url), "utf8");
  return JSON.parse(contents) as ReviewFixture;
}
