import { describe, expect, it } from "vitest";

import { externalActionDigest } from "../../../src/application/external-action.js";
import type { CampaignSnapshot } from "../../../src/application/ports/campaign-store.js";
import { issueApproval } from "../../../src/domain/approval.js";
import { publicApproval, publicCampaignSnapshot } from "../../../src/server/routes/support.js";
import { campaign } from "../../builders.js";

const action = {
  action: "create_pr" as const,
  repository: "owner/repo",
  issueNumber: 42,
  branch: "openquest/fix-42",
  baseBranch: "main",
  commitSha: "a".repeat(40),
  title: "Exact title",
  body: "Exact body",
};
const digest = externalActionDigest(action);
const proposalEvent = {
  id: "proposal-1",
  eventType: "external_action_proposed",
  payload: {
    proposalId: "proposal-1", payload: action, actionDigest: digest, expectedCampaignVersion: 7,
    expectedCampaignStatus: "contribution_approval", expectedCurrentCommitSha: action.commitSha,
    brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Passed", qodoStatus: "Clear", aiDisclosure: "AI-assisted" },
  },
  occurredAt: "2026-08-26T00:00:00Z",
  sequence: 1,
} as const;

function snapshot(): CampaignSnapshot {
  return {
    campaign: campaign({ status: "contribution_approval", version: 7 }), evidence: [], events: [proposalEvent], approvals: [], qodoFindings: [],
    externalReferences: [{ kind: "commit", value: action.commitSha }], externalActionClaims: [],
  };
}

describe("public campaign support", () => {
  it("keeps raw Qodo body and source location out of the public snapshot", () => {
    const source = snapshot();
    const finding = {
      id: "comment-101", severity: "high" as const, status: "open" as const,
      summary: "Unsafe retry", sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r101",
      body: "**Severity:** High\nUnsafe retry", path: "src/retry.ts", line: 42,
    };

    expect(publicCampaignSnapshot({ ...source, qodoFindings: [finding] }, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({
      qodoFindings: [{ id: "comment-101", severity: "high", status: "open", summary: "Unsafe retry", sourceUrl: finding.sourceUrl }],
    });
    const invalid = { ...finding, path: "../secret", line: 0, body: "x".repeat(20_001) };
    const invalidProjection = publicCampaignSnapshot({ ...source, qodoFindings: [invalid] }, Date.parse("2026-08-26T00:10:00Z"));
    expect(invalidProjection.qodoFindings).toEqual([
      { id: "comment-101", severity: "high", status: "open", summary: "Unsafe retry", sourceUrl: finding.sourceUrl },
    ]);
  });

  it("marks authority active only when trusted, unconsumed, and bound to the current proposal", () => {
    const trusted = issueApproval({
      id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: digest, issuedAt: "2026-08-26T00:00:01Z", expiresAt: "2026-08-26T01:00:00Z",
      proposalId: "proposal-1", expectedCampaignVersion: 7, expectedCampaignStatus: "contribution_approval", expectedCurrentCommitSha: action.commitSha,
      payload: action, trustedProposalAuthority: true, active: true,
    });
    expect(publicApproval(snapshot(), trusted, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({ isActive: true, proposalId: "proposal-1", expectedCampaignVersion: 7 });
    expect(publicApproval(snapshot(), { ...trusted, active: false }, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({ isActive: false });
    expect(publicApproval(snapshot(), { ...trusted, status: "consumed", consumedAt: "2026-08-26T00:05:00Z" }, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({ isActive: false });
    expect(publicApproval(snapshot(), { ...trusted, proposalId: "proposal-stale" }, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({ isActive: false });
    expect(publicApproval(snapshot(), { ...trusted, expectedCampaignVersion: 6 }, Date.parse("2026-08-26T00:10:00Z"))).toMatchObject({ isActive: false });
  });

  it("projects actual nested proposal and preflight result shapes with strict enums", () => {
    const source = snapshot();
    const response = publicCampaignSnapshot({ ...source, events: [
      proposalEvent,
      { id: "preflight", eventType: "campaign_operation_completed", occurredAt: "2026-08-26T00:01:00Z", sequence: 2, payload: { operation: "preflight", output: { verdict: "quarantine", currentCommitSha: action.commitSha }, secret: "do-not-project" } },
    ] }, Date.parse("2026-08-26T00:10:00Z"));
    expect(response.events).toEqual([
      expect.objectContaining({ facts: { action: "create_pr", expectedCampaignVersion: 7 } }),
      expect.objectContaining({ facts: { operation: "preflight", "output.verdict": "quarantine", "output.currentCommitSha": action.commitSha } }),
    ]);
    expect(JSON.stringify(response.events)).not.toContain("do-not-project");
  });

  it("projects only validated external reconciliation facts", () => {
    const source = snapshot();
    const response = publicCampaignSnapshot({ ...source, events: [
      { id: "reconciled", eventType: "external_action_reconciled", occurredAt: "2026-08-26T00:01:00Z", sequence: 1, payload: { action: "create_pr", disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40), claimedCampaignVersion: 7, resultingCampaignVersion: 8, secret: "do-not-project" } },
      { id: "invalid", eventType: "external_action_reconciled", occurredAt: "2026-08-26T00:02:00Z", sequence: 2, payload: { action: "create_pr", disposition: "operator-says-done", observedCanonicalHead: "not-a-sha", claimedCampaignVersion: 8, resultingCampaignVersion: 8 } },
    ] }, Date.parse("2026-08-26T00:10:00Z"));

    expect(response.events).toEqual([
      expect.objectContaining({ facts: expect.objectContaining({ disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40) }) }),
      expect.objectContaining({ facts: expect.not.objectContaining({ disposition: expect.anything(), observedCanonicalHead: expect.anything() }) }),
    ]);
    expect(JSON.stringify(response.events)).not.toContain("do-not-project");
  });
});
