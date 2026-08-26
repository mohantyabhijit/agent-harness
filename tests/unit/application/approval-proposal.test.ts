import { describe, expect, it } from "vitest";

import { currentApprovalProposal, proposalActionSummary } from "../../../src/application/approval-proposal.js";
import { externalActionDigest } from "../../../src/application/external-action.js";
import type { CampaignSnapshot } from "../../../src/application/ports/campaign-store.js";
import type { Approval } from "../../../src/domain/approval.js";
import { campaign } from "../../builders.js";

const action = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "a".repeat(40), title: "Fix", body: "Body" };
const actionDigest = externalActionDigest(action);
const proposalEvent = { id: "proposal-1", eventType: "external_action_proposed", occurredAt: "2026-08-26T00:00:00Z", sequence: 1, payload: {
  proposalId: "proposal-1", payload: action, actionDigest, expectedCampaignVersion: 7, expectedCampaignStatus: "contribution_approval", expectedCurrentCommitSha: action.commitSha,
  brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Passed", qodoStatus: "Clear", aiDisclosure: "AI-assisted" },
} } as const;

function proposalSnapshot(approvals: readonly Approval[]): CampaignSnapshot {
  return { campaign: campaign({ status: "contribution_approval", version: 7 }), evidence: [], events: [proposalEvent], approvals, qodoFindings: [], externalReferences: [{ kind: "commit", value: action.commitSha }], externalActionClaims: [] };
}

const exactConsumed: Approval = {
  id: "approval-consumed", campaignId: "campaign-1", action: "create_pr", actionDigest, status: "consumed", issuedAt: "2026-08-26T00:00:01Z", consumedAt: "2026-08-26T00:00:02Z",
  proposalId: "proposal-1", expectedCampaignVersion: 7, expectedCampaignStatus: "contribution_approval", expectedCurrentCommitSha: action.commitSha, payload: action, trustedProposalAuthority: true, active: false,
};

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

  it("suppresses a consumed proposal only for exact trusted proposal authority", () => {
    expect(currentApprovalProposal(proposalSnapshot([exactConsumed]))).toBeNull();
    for (const approval of [
      { ...exactConsumed, trustedProposalAuthority: false },
      { ...exactConsumed, action: "push_branch" as const },
      { ...exactConsumed, actionDigest: `sha256:${"b".repeat(64)}` },
      { ...exactConsumed, proposalId: "proposal-other" },
      { ...exactConsumed, expectedCampaignVersion: 6 },
      { ...exactConsumed, expectedCampaignStatus: "repair" as const },
      { ...exactConsumed, expectedCurrentCommitSha: "b".repeat(40) },
      { ...exactConsumed, payload: { ...action, title: "Different payload" } },
    ]) {
      expect(currentApprovalProposal(proposalSnapshot([approval]))).toMatchObject({ proposalId: "proposal-1" });
    }
  });
});
