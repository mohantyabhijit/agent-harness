import { describe, expect, it } from "vitest";

import { proposalActionSummary } from "../../../src/application/approval-proposal.js";

describe("proposal action summaries", () => {
  it.each([
    [{ action: "post_issue_comment" as const, repository: "owner/repo", issueNumber: 42, body: "May I work on this?" }, { action: "post_issue_comment", repository: "owner/repo", issueNumber: 42, body: "May I work on this?" }],
    [{ action: "request_assignment" as const, repository: "owner/repo", issueNumber: 42, assignee: "octocat" }, { action: "request_assignment", repository: "owner/repo", issueNumber: 42, assignee: "octocat" }],
    [{ action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: "b".repeat(40) }, { action: "push_branch", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", targetCommitSha: "b".repeat(40) }],
    [{ action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "a".repeat(40), title: "Fix", body: "Body" }, { action: "create_pr", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "a".repeat(40), title: "Fix", body: "Body" }],
    [{ action: "update_pr" as const, repository: "owner/repo", issueNumber: 42, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix-42", commitSha: "c".repeat(40), body: "Updated" }, { action: "update_pr", repository: "owner/repo", issueNumber: 42, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix-42", commitSha: "c".repeat(40), body: "Updated" }],
  ])("exposes every exact %s field without wrapping the executor payload", (payload, expected) => {
    expect(proposalActionSummary(payload)).toEqual(expected);
    expect(proposalActionSummary(payload)).not.toHaveProperty("payload");
  });
});
