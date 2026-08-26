import { describe, expect, it } from "vitest";

import { validateExternalActionPayload } from "../../../src/application/external-action.js";

const common = { repository: "owner/repo", issueNumber: 42 } as const;

describe("external action exact text", () => {
  it.each([
    { action: "post_issue_comment", ...common, body: "  first\tcolumn\r\nsecond line\n  " },
    { action: "create_pr", ...common, branch: "openquest/fix", baseBranch: "main", commitSha: "a".repeat(40), title: "  Exact title bytes  ", body: "body\tvalue\r\nnext\n" },
    { action: "update_pr", ...common, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix", commitSha: "a".repeat(40), body: "update\r\n\tbody\n" },
  ] as const)("accepts exact multiline bytes for $action", (payload) => {
    expect(() => { validateExternalActionPayload(payload); }).not.toThrow();
  });

  it.each([
    ["NUL", "body\u0000value"],
    ["escape", "body\u001bvalue"],
    ["bare carriage return", "body\rvalue"],
  ])("rejects %s in multiline action bodies", (_label, body) => {
    expect(() => { validateExternalActionPayload({ action: "post_issue_comment", ...common, body }); }).toThrow(/invalid external action payload/i);
  });

  it("keeps titles single-line", () => {
    expect(() => { validateExternalActionPayload({ action: "create_pr", ...common, branch: "openquest/fix", baseBranch: "main", commitSha: "a".repeat(40), title: "line one\nline two", body: "Body" }); }).toThrow(/invalid external action payload/i);
    expect(() => { validateExternalActionPayload({ action: "create_pr", ...common, branch: "openquest/fix", baseBranch: "main", commitSha: "a".repeat(40), title: "line one\u2028line two", body: "Body" }); }).toThrow(/invalid external action payload/i);
  });
});
