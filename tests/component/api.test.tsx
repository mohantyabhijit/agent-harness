// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenQuestApi, type CampaignSnapshot, type FetchLike } from "../../src/web/api.js";
import { App } from "../../src/web/App.js";

const realSpacesResponse = { spaces: ["ai_ml", "developer_tools", "web", "data", "social_impact"] };
const realCampaignResponse = {
  id: ":review.1",
  repository: "owner/repo",
  issueNumber: 1,
  issueUrl: "https://github.com/owner/repo/issues/1",
  parentSessionId: "session-1",
  lane: "easy_win",
  status: "policy_review",
  qodoIteration: 0,
  version: 1,
} as const;
const realCampaignSnapshot: CampaignSnapshot = {
  ...realCampaignResponse,
  issueBrief: null,
  fixExplanation: null,
  nextAllowedAction: null,
  evidence: [],
  events: [{ id: "created", eventType: "campaign_created", occurredAt: "2026-08-26T00:00:00Z", sequence: 1, facts: {} }],
  approvals: [],
  qodoFindings: [],
  externalReferences: [],
  externalActionClaims: [],
  approvalProposal: null,
  qualityEscalationReason: null,
};
const canonicalEvidence = [
  { id: "visibility", sourceUrl: "https://github.com/owner/repo", retrievedAt: "2026-08-26T00:00:00Z", observation: "Repository is public.", kind: "direct" as const, claim: "visibility" as const, verifiedValue: { visibility: "public" as const } },
  { id: "license", sourceUrl: "https://github.com/owner/repo/blob/main/LICENSE", retrievedAt: "2026-08-26T00:00:00Z", observation: "MIT license is present.", kind: "direct" as const, claim: "license" as const, verifiedValue: { spdxId: "MIT", path: "LICENSE" } },
  { id: "activity", sourceUrl: `https://github.com/owner/repo/commit/${"a".repeat(40)}`, retrievedAt: "2026-08-26T00:00:00Z", observation: "Recent commits are present.", kind: "direct" as const, claim: "recent_activity" as const, verifiedValue: { commitSha: "a".repeat(40), committedAt: "2026-08-25T00:00:00Z" } },
  { id: "guide", sourceUrl: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md", retrievedAt: "2026-08-26T00:00:00Z", observation: "Contribution guide is present.", kind: "direct" as const, claim: "contribution_policy" as const, verifiedValue: { path: "CONTRIBUTING.md" } },
  { id: "external-pr", sourceUrl: "https://github.com/owner/repo/pull/123", retrievedAt: "2026-08-26T00:00:00Z", observation: "An external pull request was merged.", kind: "direct" as const, claim: "external_pr_acceptance" as const, verifiedValue: { pullRequestNumber: 123, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "CONTRIBUTOR" as const } },
] as const;
const repositorySignals = {
  stars: 100,
  recentActivity: 1,
  contributionGuide: true,
  ciHealthy: true,
  externalPrAcceptance: 0.8,
  topicMatch: 1,
  maintainerResponse: 0.9,
};

function repositoryResponse(explanationEvidence: readonly Record<string, unknown>[] = canonicalEvidence) {
  return {
    repositories: [{
      repository: {
        fullName: "owner/repo",
        url: "https://github.com/owner/repo",
        description: "A healthy repository.",
        spaces: ["developer_tools"],
        license: "MIT",
        isPublic: true,
        signals: repositorySignals,
        evidence: canonicalEvidence,
      },
      score: 0.9,
      explanation: {
        inputSignals: repositorySignals,
        weightedContributions: [],
        evidence: explanationEvidence,
        sourceUrls: canonicalEvidence.map((entry) => entry.sourceUrl),
        retrievedAt: canonicalEvidence.map((entry) => entry.retrievedAt),
      },
    }],
  };
}

describe("OpenQuest browser API", () => {
  it("maps the Task 7 spaces contract and keeps capabilities off GET requests", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify(realSpacesResponse), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, baseUrl: "https://openquest.test", operatorCapability: () => "runtime-only" });

    await expect(api.getSpaces()).resolves.toEqual([
      { id: "ai_ml", name: "AI & agents", description: "Contribute to models, agents, and intelligent systems." },
      { id: "developer_tools", name: "Developer tools", description: "Improve the tools developers use to build and ship." },
      { id: "web", name: "Web & apps", description: "Build open experiences for browsers, desktops, and mobile devices." },
      { id: "data", name: "Data & infrastructure", description: "Strengthen data systems and the infrastructure behind them." },
      { id: "social_impact", name: "Civic, science & social impact", description: "Support public-interest technology, research, and access." },
    ]);
    expect(fetcher).toHaveBeenCalledWith("https://openquest.test/api/spaces", expect.not.objectContaining({ headers: expect.anything() }));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("rejects hostile and unknown space payloads before rendering them", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ spaces: ["developer_tools", "<script>"] }), { status: 200 }) });

    await expect(api.getSpaces()).rejects.toThrow(/spaces/i);
  });

  it("rejects retired category identifiers before rendering them", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ spaces: ["mobile"] }), { status: 200 }) });

    await expect(api.getSpaces()).rejects.toThrow(/spaces/i);
  });

  it("rejects an unbounded repository recommendation response", async () => {
    const response = repositoryResponse();
    const repositories = Array.from({ length: 9 }, () => response.repositories[0]);
    const api = createOpenQuestApi({
      fetch: async () => new Response(JSON.stringify({ repositories }), { status: 200 }),
      operatorCapability: () => "runtime-only",
    });

    await expect(api.discoverRepositories(["developer_tools"])).rejects.toThrow(/recommendations/i);
  });

  it("rejects multi-category discovery before making a browser request", async () => {
    const fetcher = vi.fn<FetchLike>();
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });

    await expect(api.discoverRepositories(["developer_tools", "web"])).rejects.toThrow(/recommendations/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts the strict Task 7 campaign response and projects its navigation id", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(realCampaignResponse), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).resolves.toEqual({ id: ":review.1" });
  });

  it("loads a strictly validated durable campaign snapshot without sending a capability", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify(realCampaignSnapshot), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, baseUrl: "https://openquest.test", operatorCapability: () => "runtime-only" });

    await expect(api.getCampaign(":review.1")).resolves.toEqual(realCampaignSnapshot);
    expect(fetcher).toHaveBeenCalledWith("https://openquest.test/api/campaigns/%3Areview.1", expect.not.objectContaining({ headers: expect.anything() }));
  });

  it("finalizes only a server-persisted brief with version and idempotency", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ ...realCampaignResponse, status: "coordination_pending", version: 2 }), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });

    await expect(api.finalizeCampaign(":review.1", 1, "finalize-click-0001")).resolves.toMatchObject({ status: "coordination_pending", version: 2 });
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/%3Areview.1/finalize", expect.objectContaining({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer runtime-only" }, body: JSON.stringify({ expectedVersion: 1, idempotencyKey: "finalize-click-0001" }) }));
  });

  it("publishes only the exact server-projected branch action and preserves its canonical result", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ commitSha: "b".repeat(40) }), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });
    const action = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", sourceCommitSha: "a".repeat(40), targetCommitSha: "b".repeat(40) };

    await expect(api.publishApprovedAction("campaign-1", "approval-1", action)).resolves.toEqual({ commitSha: "b".repeat(40) });
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/campaign-1/publish", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer runtime-only" },
      body: JSON.stringify({ approvalId: "approval-1", payload: { action: "push_branch", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", commitSha: "b".repeat(40) } }),
    }));
  });

  it("publishes an exact server-projected pull request action and rejects an action-specific response mismatch", async () => {
    const action = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "b".repeat(40), title: "Fix issue 42", body: "Verified tests, risks, rollback, AI disclosure" };
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ pullRequest: "https://github.com/owner/repo/pull/17" }), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });

    await expect(api.publishApprovedAction("campaign-1", "approval-1", action)).resolves.toEqual({ pullRequest: "https://github.com/owner/repo/pull/17" });
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ approvalId: "approval-1", payload: action }));

    const mismatch = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ commitSha: "b".repeat(40) }), { status: 200 }), operatorCapability: () => "runtime-only" });
    await expect(mismatch.publishApprovedAction("campaign-1", "approval-1", action)).rejects.toThrow(/unexpected result/i);
  });

  it("preserves the reconciliation-required publication error code", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ code: "publication_outcome_unknown", message: "Publication outcome is unknown; reconciliation is required" }), { status: 409 }), operatorCapability: () => "runtime-only" });
    const action = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "b".repeat(40), title: "Fix issue 42", body: "Verified tests, risks, rollback, AI disclosure" };

    await expect(api.publishApprovedAction("campaign-1", "approval-1", action)).rejects.toMatchObject({ code: "publication_outcome_unknown", status: 409 });
  });

  it("distinguishes missing publication authority before any network attempt", async () => {
    const fetcher = vi.fn<FetchLike>();
    const api = createOpenQuestApi({ fetch: fetcher });
    const action = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: "b".repeat(40), title: "Fix issue 42", body: "Verified tests, risks, rollback, AI disclosure" };

    await expect(api.publishApprovedAction("campaign-1", "approval-1", action)).rejects.toMatchObject({ code: "operator_capability_missing", status: undefined });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed durable campaign facts at the browser boundary", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ ...realCampaignSnapshot, events: [{ ...realCampaignSnapshot.events[0], transcript: "do not expose" }] }), { status: 200 }) });

    await expect(api.getCampaign(":review.1")).rejects.toThrow(/campaign/i);
  });

  it("round-trips a bounded Qodo discussion URL with its fragment", async () => {
    const sourceUrl = "https://github.com/owner/repo/pull/7#discussion_r123";
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ ...realCampaignSnapshot, qodoFindings: [{ id: "qodo-1", severity: "medium", status: "open", summary: "Fix boundary", sourceUrl }] }), { status: 200 }) });
    await expect(api.getCampaign(":review.1")).resolves.toMatchObject({ qodoFindings: [{ sourceUrl }] });
  });

  it.each([
    { action: "post_issue_comment", repository: "owner/repo", issueNumber: 1, body: "  exact\tcomment\r\nbytes\n  " },
    { action: "request_assignment", repository: "owner/repo", issueNumber: 1, assignee: "octocat" },
    { action: "push_branch", repository: "owner/repo", issueNumber: 1, branch: "openquest/fix-1", sourceCommitSha: "a".repeat(40), targetCommitSha: "b".repeat(40) },
    { action: "create_pr", repository: "owner/repo", issueNumber: 1, branch: "openquest/fix-1", baseBranch: "main", commitSha: "b".repeat(40), title: "  exact title bytes  ", body: "  exact\tPR\r\nbody\nbytes  " },
    { action: "update_pr", repository: "owner/repo", issueNumber: 1, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix-1", commitSha: "b".repeat(40), body: "  exact\tupdate\r\nbytes\n  " },
  ] as const)("preserves every exact $action field at the browser boundary", async (action) => {
    const response = { ...realCampaignSnapshot, version: 7, approvalProposal: { proposalId: "proposal-exact", actionDigest: `sha256:${"b".repeat(64)}`, expectedCampaignVersion: 7, action, brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Pass", qodoStatus: "Clear", aiDisclosure: "AI-assisted" } } };
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(response), { status: 200 }) });
    await expect(api.getCampaign(":review.1")).resolves.toMatchObject({ approvalProposal: { action } });
  });

  it.each([
    ["multiline title", { action: "create_pr", repository: "owner/repo", issueNumber: 1, branch: "openquest/fix-1", baseBranch: "main", commitSha: "b".repeat(40), title: "line one\nline two", body: "Body" }],
    ["NUL body", { action: "post_issue_comment", repository: "owner/repo", issueNumber: 1, body: "unsafe\u0000body" }],
  ] as const)("rejects a proposal with %s", async (_label, action) => {
    const response = { ...realCampaignSnapshot, version: 7, approvalProposal: { proposalId: "proposal-exact", actionDigest: `sha256:${"b".repeat(64)}`, expectedCampaignVersion: 7, action, brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Pass", qodoStatus: "Clear", aiDisclosure: "AI-assisted" } } };
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(response), { status: 200 }) });

    await expect(api.getCampaign(":review.1")).rejects.toThrow(/campaign/i);
  });

  it("rejects transformed proposal identifiers instead of trimming them", async () => {
    const response = { ...realCampaignSnapshot, version: 7, approvalProposal: { proposalId: " proposal-exact ", actionDigest: `sha256:${"b".repeat(64)}`, expectedCampaignVersion: 7, action: { action: "request_assignment", repository: "owner/repo", issueNumber: 1, assignee: "octocat" }, brief: { policy: "Policy", approach: "Approach", files: ["src/a.ts"], risks: ["Risk"], tests: ["npm test"], safetyResult: "Pass", qodoStatus: "Clear", aiDisclosure: "AI-assisted" } } };
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(response), { status: 200 }) });

    await expect(api.getCampaign(":review.1")).rejects.toThrow(/campaign/i);
  });

  it.each([
    ["unknown disposition", { action: "create_pr", disposition: "operator-says-done", claimedCampaignVersion: 7, resultingCampaignVersion: 7 }],
    ["invalid canonical head", { action: "create_pr", disposition: "confirmed_completed", observedCanonicalHead: "not-a-sha", claimedCampaignVersion: 7, resultingCampaignVersion: 8 }],
    ["secret fact", { action: "create_pr", disposition: "confirmed_completed", claimedCampaignVersion: 7, resultingCampaignVersion: 7, operatorToken: "do-not-render" }],
  ] as const)("rejects external reconciliation facts with an %s", async (_label, facts) => {
    const response = { ...realCampaignSnapshot, events: [{ id: "reconciled", eventType: "external_action_reconciled", occurredAt: "2026-08-26T00:00:00Z", sequence: 1, facts }] };
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(response), { status: 200 }) });

    await expect(api.getCampaign(":review.1")).rejects.toThrow(/campaign/i);
  });

  it("issues approval for the server-owned proposal identity with the supplied human-confirmation key", async () => {
    const confirmation = { proposalId: "proposal-1", actionDigest: `sha256:${"b".repeat(64)}`, expectedCampaignVersion: 7 };
    const approval = { id: "approval-1", action: "create_pr", actionDigest: `sha256:${"b".repeat(64)}`, status: "approved", issuedAt: "2026-08-26T00:00:00Z", proposalId: "proposal-1", expectedCampaignVersion: 7, isActive: true } as const;
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ approval }), { status: 201 }));
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });

    await expect(api.issueApproval(":review.1", confirmation, "approval-click-0001")).resolves.toEqual(approval);
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/%3Areview.1/approvals", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer runtime-only", "idempotency-key": "approval-click-0001" },
      body: JSON.stringify(confirmation),
    }));
  });

  it("starts only a declared campaign operation with the operator capability", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify(realCampaignResponse), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, operatorCapability: () => "runtime-only" });

    await expect(api.runCampaignAction(":review.1", "preflight")).resolves.toEqual(realCampaignResponse);
    expect(fetcher).toHaveBeenCalledWith("/api/campaigns/%3Areview.1/actions/preflight", expect.objectContaining({
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer runtime-only" }, body: "{}",
    }));
  });

  it("rejects campaign responses with unexpected fields", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ ...realCampaignResponse, operatorToken: "not-for-client" }), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).rejects.toThrow(/campaign/i);
  });

  it("accepts claim-specific direct verification evidence for repository discovery", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(repositoryResponse()), { status: 200 }), operatorCapability: () => "runtime-only" });

    await expect(api.discoverRepositories(["developer_tools"])).resolves.toMatchObject({ values: expect.arrayContaining([expect.anything()]) });
  });

  it.each([
    ["retrieval timestamp", canonicalEvidence.map((entry, index) => index === 0 ? { ...entry, retrievedAt: "2026-08-26T00:01:00Z" } : entry)],
    ["evidence kind", canonicalEvidence.map((entry, index) => index === 0 ? { ...entry, kind: "inference" as const } : entry)],
  ])("rejects explanation evidence with a mismatched %s", async (_label, explanationEvidence) => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(repositoryResponse(explanationEvidence)), { status: 200 }), operatorCapability: () => "runtime-only" });

    await expect(api.discoverRepositories(["developer_tools"])).rejects.toThrow(/recommendations/i);
  });
});

describe("operator access", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("does not block local development behind a capability screen", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /find work that is worth shipping/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /tell openquest what you want to build/i })).toBeVisible();
    expect(screen.queryByLabelText(/operator capability/i)).not.toBeInTheDocument();
  });

  it("keeps an injected capability connected and focuses the route heading", async () => {
    window.history.replaceState({}, "", "/campaigns/campaign-1");
    render(<App operatorCapability={() => "runtime-only"} />);

    const campaignHeading = screen.getByRole("heading", { name: /campaign created/i });
    await vi.waitFor(() => {
      expect(campaignHeading).toHaveFocus();
    });
    expect(screen.queryByRole("button", { name: /disconnect/i })).not.toBeInTheDocument();
  });
});
