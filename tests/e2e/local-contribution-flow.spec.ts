import { expect, test } from "@playwright/test";

const source = "a".repeat(40);
const target = "b".repeat(40);
const pushDigest = `sha256:${"c".repeat(64)}`;
const prDigest = `sha256:${"d".repeat(64)}`;
const issueUrl = "https://github.com/owner/repo/issues/42";
const branch = "openquest/fix-42";
const pullRequest = "https://github.com/owner/repo/pull/17";

const repository = {
  fullName: "owner/repo", url: "https://github.com/owner/repo", description: "A local fixture repository.", spaces: ["developer_tools"], license: "MIT", isPublic: true,
  signals: { stars: 100, recentActivity: 1, contributionGuide: true, ciHealthy: true, externalPrAcceptance: 0.8, topicMatch: 1, maintainerResponse: 0.9 },
  evidence: [
    { id: "visibility", sourceUrl: "https://github.com/owner/repo", retrievedAt: "2026-08-26T00:00:00Z", observation: "Repository is public.", kind: "direct", claim: "visibility", verifiedValue: { visibility: "public" } },
    { id: "license", sourceUrl: "https://github.com/owner/repo/blob/main/LICENSE", retrievedAt: "2026-08-26T00:00:00Z", observation: "MIT license is present.", kind: "direct", claim: "license", verifiedValue: { spdxId: "MIT", path: "LICENSE" } },
    { id: "activity", sourceUrl: `https://github.com/owner/repo/commit/${source}`, retrievedAt: "2026-08-26T00:00:00Z", observation: "Recent commits are present.", kind: "direct", claim: "recent_activity", verifiedValue: { commitSha: source, committedAt: "2026-08-25T00:00:00Z" } },
    { id: "guide", sourceUrl: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md", retrievedAt: "2026-08-26T00:00:00Z", observation: "Contribution guide is present.", kind: "direct", claim: "contribution_policy", verifiedValue: { path: "CONTRIBUTING.md" } },
    { id: "external-pr", sourceUrl: "https://github.com/owner/repo/pull/123", retrievedAt: "2026-08-26T00:00:00Z", observation: "An external pull request was merged.", kind: "direct", claim: "external_pr_acceptance", verifiedValue: { pullRequestNumber: 123, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "CONTRIBUTOR" } },
  ],
};
const repositoryExplanation = { inputSignals: repository.signals, weightedContributions: [], evidence: repository.evidence, sourceUrls: repository.evidence.map(({ sourceUrl }) => sourceUrl), retrievedAt: repository.evidence.map(({ retrievedAt }) => retrievedAt) };
const issue = { repository: "owner/repo", number: 42, title: "Handle an empty dependency response", url: issueUrl, clarity: 0.95, affectedAreas: 1, testComplexity: 0.2, dependencyRisk: 0.1, estimatedHours: 2, maintainerSignals: ["Focused changes are welcome."] };
const brief = { problem: "An empty dependency response can be read before it is checked.", likelyCause: "The boundary assumes a first item exists.", smallestFix: "Guard the empty response and add a regression test.", affectedAreas: ["src/dependencies.ts"], tests: ["npm test -- dependencies"], risks: ["Callers may now receive an explicit empty result."], uncertainty: "No additional uncertainty is known from the issue evidence.", evidence: [{ sourceUrl: issueUrl, observation: "The issue documents the expected empty-response behavior." }] };

test("completes the local campaign flow through separate push and pull-request publication approvals", async ({ page }) => {
  let phase: "brief" | "coordination" | "baseline" | "implementation" | "push" | "create-pr" | "opened" = "brief";
  let pushApproved = false;
  let prApproved = false;
  const publicationRequests: Array<Record<string, unknown>> = [];

  await page.route("http://localhost:8790/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const session = { id: "session-qa", title: "Local QA campaign", agent: { type: "reference", id: "agent-openquest", name: "openquest" }, createdBySubject: "local-qa", createdAt: "2026-08-26T00:00:00Z", updatedAt: "2026-08-26T00:00:00Z" };
    if (path === "/api/v1/sessions") return route.fulfill({ json: { data: [session], pagination: {} } });
    if (path === "/api/v1/sessions/session-qa") return route.fulfill({ json: session });
    if (path === "/api/v1/sessions/session-qa/turns" || path === "/api/v1/sessions/session-qa/events") return route.fulfill({ json: { data: [], pagination: {} } });
    return route.fulfill({ status: 404, json: { message: "Controlled TrueForge fixture route not found" } });
  });
  await page.route("**/api/spaces", async (route) => route.fulfill({ json: { spaces: ["ai_ml", "developer_tools", "web", "data", "social_impact"] } }));
  await page.route("**/api/discovery/classify", async (route) => route.fulfill({ json: { kind: "category", space: "developer_tools" } }));
  await page.route("**/api/discovery/repositories", async (route) => route.fulfill({ json: { repositories: [{ repository, score: 0.9, explanation: repositoryExplanation }] } }));
  await page.route("**/api/discovery/repositories/owner/repo/issues", async (route) => route.fulfill({ json: { issues: [issue] } }));
  await page.route("**/api/campaigns/campaign-qa**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ json: campaignSnapshot(phase, pushApproved, prApproved) });
    if (url.pathname.endsWith("/finalize")) { phase = "coordination"; return route.fulfill({ json: campaignCore("coordination_pending", 2) }); }
    if (url.pathname.endsWith("/actions/preflight")) { phase = "baseline"; return route.fulfill({ json: campaignCore("baseline", 3) }); }
    if (url.pathname.endsWith("/actions/implement")) { phase = "implementation"; return route.fulfill({ json: campaignCore("implementation", 4) }); }
    if (url.pathname.endsWith("/actions/verify")) { phase = "push"; return route.fulfill({ json: campaignCore("contribution_approval", 5) }); }
    if (url.pathname.endsWith("/approvals")) {
      const body = request.postDataJSON() as { proposalId: string };
      if (body.proposalId === "proposal-push") pushApproved = true;
      if (body.proposalId === "proposal-pr") prApproved = true;
      return route.fulfill({ status: 201, json: { approval: approval(body.proposalId === "proposal-push" ? "push_branch" : "create_pr", body.proposalId, body.proposalId === "proposal-push" ? pushDigest : prDigest) } });
    }
    if (url.pathname.endsWith("/publish")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      publicationRequests.push(body);
      if ((body.payload as { action: string }).action === "push_branch") { phase = "create-pr"; return route.fulfill({ json: { commitSha: target } }); }
      phase = "opened";
      return route.fulfill({ json: { pullRequest } });
    }
    return route.fulfill({ status: 404, json: { code: "not_found", message: "Fixture route not found" } });
  });
  await page.route("**/api/campaigns", async (route) => route.fulfill({ status: 201, json: campaignCore("policy_review", 1) }));

  await page.goto("/");
  await page.getByRole("button", { name: /developer tools/i }).click();
  await expect(page).toHaveURL(/\/discover\?spaces=developer_tools/);
  await expect(page.getByRole("button", { name: /start with handle an empty dependency response/i })).toBeVisible();
  await page.getByRole("button", { name: /start with handle an empty dependency response/i }).click();
  await expect(page).toHaveURL(/\/campaigns\/campaign-qa/);
  await expect(page.getByRole("heading", { name: /problem and proposed fix/i })).toBeVisible();
  await page.getByRole("button", { name: /finalize issue brief/i }).click();
  await expect(page.getByRole("button", { name: /start static preflight/i })).toBeVisible();
  await page.getByRole("button", { name: /start static preflight/i }).click();
  await expect(page.getByRole("button", { name: /run isolated implementation/i })).toBeVisible();
  await page.getByRole("button", { name: /run isolated implementation/i }).click();
  await expect(page.getByRole("button", { name: /run verification/i })).toBeVisible();
  await page.getByRole("button", { name: /run verification/i }).click();
  await expect(page.getByRole("heading", { name: /exact external action/i })).toBeVisible();
  await page.getByRole("checkbox", { name: /reviewed every field/i }).check();
  await page.getByRole("button", { name: /approve scoped branch push proposal/i }).click();
  await expect(page.getByRole("button", { name: /push approved branch/i })).toBeVisible();
  await page.getByRole("button", { name: /push approved branch/i }).click();
  await expect(page.getByRole("button", { name: /approve scoped pull request proposal/i })).toBeVisible();
  await page.getByRole("checkbox", { name: /reviewed every field/i }).check();
  await page.getByRole("button", { name: /approve scoped pull request proposal/i }).click();
  await expect(page.getByRole("button", { name: /create approved pull request/i })).toBeVisible();
  await page.getByRole("button", { name: /create approved pull request/i }).click();
  await expect(page.getByText(/easy win · pull request open/i)).toBeVisible();
  await page.getByText(/durable external references/i).click();
  await expect(page.getByText(pullRequest)).toBeVisible();
  expect(publicationRequests).toEqual([
    { approvalId: "approval-push", payload: { action: "push_branch", repository: "owner/repo", issueNumber: 42, branch, commitSha: target } },
    { approvalId: "approval-pr", payload: { action: "create_pr", repository: "owner/repo", issueNumber: 42, branch, baseBranch: "main", commitSha: target, title: "Fix issue 42", body: expect.any(String) } },
  ]);
});

function campaignCore(status: string, version: number) { return { id: "campaign-qa", repository: "owner/repo", issueNumber: 42, issueUrl, parentSessionId: "session-qa", lane: "easy_win", status, qodoIteration: 0, version }; }
function approval(action: "push_branch" | "create_pr", proposalId: string, actionDigest: string) { return { id: `approval-${action === "push_branch" ? "push" : "pr"}`, action, actionDigest, status: "approved", issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2099-08-26T00:00:00Z", proposalId, expectedCampaignVersion: 5, isActive: true }; }
function campaignSnapshot(phase: "brief" | "coordination" | "baseline" | "implementation" | "push" | "create-pr" | "opened", pushApproved: boolean, prApproved: boolean) {
  const status = phase === "brief" ? "policy_review" : phase === "coordination" ? "coordination_pending" : phase === "baseline" ? "baseline" : phase === "implementation" ? "implementation" : phase === "opened" ? "pull_request_open" : "contribution_approval";
  const version = phase === "brief" ? 1 : phase === "coordination" ? 2 : phase === "baseline" ? 3 : phase === "implementation" ? 4 : phase === "opened" ? 6 : 5;
  const pushAction = { action: "push_branch" as const, repository: "owner/repo", issueNumber: 42, branch, sourceCommitSha: target, targetCommitSha: target };
  const prAction = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch, baseBranch: "main", commitSha: target, title: "Fix issue 42", body: "Fixes https://github.com/owner/repo/issues/42\nVerified tests: npm test\nRisks: low\nRollback: revert the commit\nAI disclosure: TrueForge assisted this change." };
  const action = phase === "create-pr" || phase === "opened" ? prAction : pushAction;
  const proposalId = phase === "create-pr" || phase === "opened" ? "proposal-pr" : "proposal-push";
  const actionDigest = phase === "create-pr" || phase === "opened" ? prDigest : pushDigest;
  const approvals = phase === "create-pr" || phase === "opened" ? (prApproved ? [approval("create_pr", "proposal-pr", prDigest)] : []) : (pushApproved ? [approval("push_branch", "proposal-push", pushDigest)] : []);
  const currentCommit = ["implementation", "push", "create-pr", "opened"].includes(phase) ? target : source;
  const references = [{ kind: "commit" as const, value: currentCommit }, ...(phase === "create-pr" || phase === "opened" ? [{ kind: "branch" as const, value: branch }] : []), ...(phase === "opened" ? [{ kind: "pull_request" as const, value: pullRequest }] : [])];
  return { ...campaignCore(status, version), issueBrief: brief, fixExplanation: null, nextAllowedAction: phase === "coordination" ? "preflight" : phase === "baseline" ? "implement" : phase === "implementation" ? "verify" : null, evidence: [], events: [], approvals, qodoFindings: [], externalReferences: references, externalActionClaims: [], approvalProposal: phase === "push" || phase === "create-pr" ? { proposalId, actionDigest, expectedCampaignVersion: version, action, brief: { policy: "Focused changes only.", approach: "Apply the smallest fix.", files: ["src/dependencies.ts"], risks: ["Empty responses are now explicit."], tests: ["npm test"], safetyResult: "Static preflight passed.", qodoStatus: "No unresolved high findings.", aiDisclosure: "TrueForge assisted this change; a human reviews it." } } : null, qualityEscalationReason: null };
}
