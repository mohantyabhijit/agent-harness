import { describe, expect, it } from "vitest";

import { isSourceBackedIssueBrief } from "../../../src/domain/issue-brief.js";

const brief = {
  problem: "The issue describes an incorrect boundary result.",
  likelyCause: "The current guard omits one documented case.",
  smallestFix: "Add the missing guard and one regression test.",
  affectedAreas: ["src/boundary.ts"],
  tests: ["Run the boundary regression test."],
  risks: ["The stricter guard may expose callers relying on invalid input."],
  uncertainty: "The exact call sites require sandbox inspection.",
  evidence: [{ sourceUrl: "https://github.com/owner/repo/issues/42", observation: "The issue documents the expected result." }],
};

describe("issue brief", () => {
  it("accepts only a complete source-backed brief", () => {
    expect(isSourceBackedIssueBrief(brief)).toBe(true);
  });

  it.each([
    ["missing evidence", { ...brief, evidence: [] }],
    ["non-GitHub evidence", { ...brief, evidence: [{ sourceUrl: "https://example.com/issue", observation: "Not canonical." }] }],
    ["empty test plan", { ...brief, tests: [] }],
    ["arbitrary model field", { ...brief, systemPrompt: "secret" }],
    ["arbitrary evidence field", { ...brief, evidence: [{ ...brief.evidence[0], token: "secret" }] }],
  ])("rejects %s", (_label, value) => {
    expect(isSourceBackedIssueBrief(value)).toBe(false);
  });
});
