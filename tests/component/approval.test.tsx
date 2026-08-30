// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({
  ServerProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  SlotsProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  Thread: () => null,
  TrueForgeUI: () => <div />,
  TrueFoundryChatProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

import { externalActionDigest, type ExternalActionPayload } from "../../src/application/external-action.js";
import type { CampaignStatus } from "../../src/domain/campaign.js";
import { buildApp } from "../../src/server/app.js";
import { createOpenQuestApi, type ApprovalActionSummary, type ApprovalProposal, type CampaignSnapshot, type FetchLike, type OpenQuestApi } from "../../src/web/api.js";
import { CampaignTimeline } from "../../src/web/components/CampaignTimeline.js";
import { ChangeBrief } from "../../src/web/components/ChangeBrief.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";
import { campaign } from "../builders.js";
import { FakeCampaignStore } from "../fakes/fake-campaign-store.js";
import { FakeHarness } from "../fakes/fake-harness.js";

const payload: ApprovalActionSummary = {
  action: "create_pr",
  repository: "owner/repo",
  issueNumber: 42,
  branch: "openquest/fix-42",
  baseBranch: "main",
  commitSha: "a".repeat(40),
  title: "Handle an empty dependency response",
  body: "Resolves #42.\n\nAI-assisted contribution: OpenQuest prepared this change and the operator reviewed the exact payload.",
};
const proposal: ApprovalProposal = {
  proposalId: "proposal-1",
  action: payload,
  actionDigest: `sha256:${"b".repeat(64)}`,
  expectedCampaignVersion: 7,
  brief: {
    policy: "Focused pull requests with tests are welcome.",
    approach: "Guard the empty result before reading its first item.",
    files: ["src/dependencies.ts", "tests/dependencies.test.ts"],
    risks: ["A provider may return a malformed success response."],
    tests: ["npm test -- tests/dependencies.test.ts"],
    safetyResult: "Static preflight passed; no install scripts or credentials were executed.",
    qodoStatus: "No open high-severity findings.",
    aiDisclosure: "AI-assisted contribution prepared by OpenQuest and explicitly reviewed by a human operator.",
  },
};
const snapshot: CampaignSnapshot = {
  issueBrief: null,
  fixExplanation: null,
  id: "campaign-1", repository: "owner/repo", issueNumber: 42, issueUrl: "https://github.com/owner/repo/issues/42", parentSessionId: "session-42", lane: "easy_win", status: "contribution_approval", qodoIteration: 0, version: 7, nextAllowedAction: null,
  evidence: [], events: [], approvals: [], qodoFindings: [], externalReferences: [{ kind: "commit", value: "a".repeat(40) }], externalActionClaims: [], approvalProposal: proposal, qualityEscalationReason: null,
};

describe("ChangeBrief", () => {
  afterEach(cleanup);

  it("shows the full exact action before enabling explicit approval", async () => {
    const approve = vi.fn();
    render(<ChangeBrief onApprove={approve} proposal={proposal} />);

    expect(screen.getByText(payload.title)).toBeVisible();
    expect(screen.getByText(/AI-assisted contribution: OpenQuest prepared this change/i)).toBeVisible();
    expect(screen.getByText(proposal.brief.policy)).toBeVisible();
    expect(screen.getByText(proposal.brief.approach)).toBeVisible();
    expect(screen.getByText("src/dependencies.ts")).toBeVisible();
    expect(screen.getByText(proposal.brief.risks[0] ?? "")).toBeVisible();
    expect(screen.getByText(proposal.brief.tests[0] ?? "")).toBeVisible();
    expect(screen.getByText(proposal.brief.safetyResult)).toBeVisible();
    expect(screen.getByText(proposal.brief.qodoStatus)).toBeVisible();
    expect(screen.getByText(proposal.brief.aiDisclosure)).toBeVisible();
    expect(screen.getByText(proposal.actionDigest)).toBeVisible();
    const button = screen.getByRole("button", { name: /approve scoped pull request proposal/i });
    expect(button).toBeDisabled();
    expect(approve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(button);

    expect(approve).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith({ proposalId: "proposal-1", actionDigest: proposal.actionDigest, expectedCampaignVersion: 7 });
  });

  it("requires a new acknowledgement when proposal identity or expected version changes with the same digest", () => {
    const approve = vi.fn();
    const view = render(<ChangeBrief onApprove={approve} proposal={proposal} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    expect(screen.getByRole("button", { name: /approve scoped pull request/i })).toBeEnabled();

    view.rerender(<ChangeBrief onApprove={approve} proposal={{ ...proposal, proposalId: "proposal-2", expectedCampaignVersion: 8 }} />);

    expect(screen.getByRole("checkbox", { name: /reviewed every field/i })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /approve scoped pull request/i })).toBeDisabled();
    view.rerender(<ChangeBrief onApprove={approve} proposal={proposal} />);
    expect(screen.getByRole("checkbox", { name: /reviewed every field/i })).not.toBeChecked();
  });

  it.each([
    [{ action: "post_issue_comment", repository: "owner/repo", issueNumber: 42, body: "May I work on this?" }, "Issue comment"],
    [{ action: "request_assignment", repository: "owner/repo", issueNumber: 42, assignee: "octocat" }, "Requested assignee"],
    [{ action: "push_branch", repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", sourceCommitSha: "a".repeat(40), targetCommitSha: "b".repeat(40) }, "Source commit"],
    [payload, "Pull request title"],
    [{ action: "update_pr", repository: "owner/repo", issueNumber: 42, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/fix-42", commitSha: "b".repeat(40), body: "Updated body" }, "Updated body"],
  ] as const)("renders every exact %s action brief", (action, expectedLabel) => {
    render(<ChangeBrief onApprove={vi.fn()} proposal={{ ...proposal, action }} />);
    expect(screen.getAllByText(expectedLabel)[0]).toBeVisible();
  });

  it("preserves all five exact actions through the Fastify route, browser parser, and rendered brief", async () => {
    const fixtures: readonly { readonly payload: ExternalActionPayload; readonly status: CampaignStatus; readonly head?: string; readonly pullRequest?: string; readonly checks: readonly (readonly [string, string])[] }[] = [
      { payload: { action: "post_issue_comment", repository: "owner/repo", issueNumber: 42, body: "  exact\tcomment\r\nsecond line\n  " }, status: "coordination_pending", checks: [["Issue comment", "  exact\tcomment\r\nsecond line\n  "]] },
      { payload: { action: "request_assignment", repository: "owner/repo", issueNumber: 42, assignee: "octocat-dev" }, status: "coordination_pending", checks: [["Requested assignee", "octocat-dev"]] },
      { payload: { action: "push_branch", repository: "owner/repo", issueNumber: 42, branch: "openquest/exact-42", commitSha: "b".repeat(40) }, status: "contribution_approval", head: "a".repeat(40), checks: [["Branch", "openquest/exact-42"], ["Source commit", "a".repeat(40)], ["Target commit", "b".repeat(40)]] },
      { payload: { action: "create_pr", repository: "owner/repo", issueNumber: 42, branch: "openquest/exact-42", baseBranch: "main", commitSha: "a".repeat(40), title: "  Exact title bytes  ", body: "  exact\tPR\r\nbody\n  " }, status: "contribution_approval", head: "a".repeat(40), checks: [["Pull request title", "  Exact title bytes  "], ["Pull request body", "  exact\tPR\r\nbody\n  "]] },
      { payload: { action: "update_pr", repository: "owner/repo", issueNumber: 42, pullRequest: "https://github.com/owner/repo/pull/7", branch: "openquest/exact-42", commitSha: "c".repeat(40), body: "  exact\tupdate\r\nbody\n  " }, status: "repair", head: "c".repeat(40), pullRequest: "https://github.com/owner/repo/pull/7", checks: [["Pull request", "https://github.com/owner/repo/pull/7"], ["Updated body", "  exact\tupdate\r\nbody\n  "]] },
    ];

    for (const [index, fixture] of fixtures.entries()) {
      cleanup();
      const store = new FakeCampaignStore();
      store.seed(campaign({ status: fixture.status, version: 7 }));
      if (fixture.head !== undefined) store.seedExternalReference("campaign-1", { kind: "commit", value: fixture.head });
      if (fixture.pullRequest !== undefined) store.seedExternalReference("campaign-1", { kind: "pull_request", value: fixture.pullRequest });
      const proposalId = `proposal-exact-${String(index)}`;
      await store.appendEvent("campaign-1", { id: proposalId, eventType: "external_action_proposed", occurredAt: "2026-08-26T00:00:00Z", payload: {
        proposalId, payload: fixture.payload, actionDigest: externalActionDigest(fixture.payload), expectedCampaignVersion: 7, expectedCampaignStatus: fixture.status,
        ...(fixture.head === undefined ? {} : { expectedCurrentCommitSha: fixture.head }),
        brief: proposal.brief,
      } });
      const app = buildApp({ store, harness: new FakeHarness(), catalog: { listRepositories: async () => [], listIssues: async () => [] }, clock: { now: () => "2026-08-26T00:00:00Z" }, ids: { next: () => "unused-id" }, authorization: { require: () => undefined } });
      const fetcher: FetchLike = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const response = await app.inject({ method: init?.method === "POST" ? "POST" : "GET", url, headers: Object.fromEntries(new Headers(init?.headers).entries()), ...(typeof init?.body === "string" ? { payload: init.body } : {}) });
        return new Response(response.body, { status: response.statusCode, headers: new Headers(response.headers as Record<string, string>) });
      };

      const loaded = await createOpenQuestApi({ fetch: fetcher }).getCampaign("campaign-1");
      expect(loaded.approvalProposal).not.toBeNull();
      render(<ChangeBrief onApprove={vi.fn()} proposal={loaded.approvalProposal as ApprovalProposal} />);
      for (const [label, exactValue] of fixture.checks) {
        const labelNode = screen.getAllByText(label).find((element) => element.tagName === "DT");
        const rendered = labelNode?.parentElement?.querySelector<HTMLElement>(".pre-wrap")?.textContent;
        expect(rendered).toBe(exactValue);
      }
      await app.close();
    }
  });

  it("accepts a legacy reconciled event without a disposition through Fastify and renders a generic label", async () => {
    const routeStore = {
      get: async () => ({
        campaign: campaign({ status: "contribution_approval", version: 7 }),
        evidence: [],
        events: [{ id: "legacy-reconciled", eventType: "external_action_reconciled", occurredAt: "2026-08-26T00:00:00Z", sequence: 1, payload: { action: "create_pr", reason: "human_external_action_reconciliation", claimedCampaignVersion: 7, resultingCampaignVersion: 7 } }],
        approvals: [],
        qodoFindings: [],
        externalReferences: [],
        externalActionClaims: [],
      }),
    };
    const app = buildApp({ store: routeStore as never, harness: new FakeHarness(), catalog: { listRepositories: async () => [], listIssues: async () => [] }, clock: { now: () => "2026-08-26T00:00:00Z" }, ids: { next: () => "unused-id" }, authorization: { require: () => undefined } });
    const fetcher: FetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = await app.inject({ method: "GET", url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.body, { status: response.statusCode, headers: new Headers(response.headers as Record<string, string>) });
    };

    const loaded = await createOpenQuestApi({ fetch: fetcher }).getCampaign("campaign-1");
    render(<CampaignTimeline approvals={loaded.approvals} events={loaded.events} />);

    expect(screen.getByText("External action reconciled")).toBeVisible();
    expect(screen.queryByText(/confirmed completed/i)).not.toBeInTheDocument();
    await app.close();
  });
});

describe("Campaign approval", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("locks approval while a campaign action awaits authoritative refresh", async () => {
    const preflightProposal: ApprovalProposal = {
      ...proposal,
      action: { action: "post_issue_comment", repository: "owner/repo", issueNumber: 42, body: "May I work on this?" },
    };
    const actionSnapshot = { ...snapshot, status: "coordination_pending" as const, nextAllowedAction: "preflight" as const, approvalProposal: preflightProposal };
    const getCampaign = vi.fn<OpenQuestApi["getCampaign"]>()
      .mockResolvedValueOnce(actionSnapshot)
      .mockImplementationOnce(() => new Promise<CampaignSnapshot>(() => undefined));
    const runCampaignAction = vi.fn<NonNullable<OpenQuestApi["runCampaignAction"]>>(async () => ({ ...actionSnapshot, status: "preflight" as const }));
    const issueApproval = vi.fn<OpenQuestApi["issueApproval"]>(async () => { throw new Error("Approval must remain locked"); });

    render(<CampaignPage api={{ getCampaign, issueApproval, runCampaignAction }} campaignId="campaign-1" createIdempotencyKey={() => "approval-action-lock"} />);

    await screen.findByRole("button", { name: /start static preflight/i });
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    const approval = screen.getByRole("button", { name: /approve scoped issue comment proposal/i });
    expect(approval).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /start static preflight/i }));
    await waitFor(() => { expect(runCampaignAction).toHaveBeenCalledOnce(); });

    expect(approval).toBeDisabled();
    fireEvent.click(approval);
    expect(issueApproval).not.toHaveBeenCalled();
  });

  it("generates one bounded visible-ASCII key per explicit click and prevents double submission", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const issueApproval = vi.fn<OpenQuestApi["issueApproval"]>(async () => {
      await pending;
      return { id: "approval-1", action: "create_pr", actionDigest: proposal.actionDigest, status: "approved", issuedAt: "2026-08-26T00:10:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    });
    const getCampaign = vi.fn(async () => snapshot);
    const api = { getCampaign, issueApproval };
    render(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-click-0001"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    const button = screen.getByRole("button", { name: /approve scoped pull request proposal/i });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(issueApproval).toHaveBeenCalledOnce();
    expect(issueApproval).toHaveBeenCalledWith("campaign-1", { proposalId: "proposal-1", actionDigest: proposal.actionDigest, expectedCampaignVersion: 7 }, "approval-click-0001", expect.any(AbortSignal));
    const key = issueApproval.mock.calls[0]?.[2] ?? "";
    expect(key).toMatch(/^[\x21-\x7e]{8,128}$/u);
    release();
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(2); });
  });

  it("aborts an in-flight approval when the campaign page unmounts", async () => {
    let approvalSignal: AbortSignal | undefined;
    const api: Pick<OpenQuestApi, "getCampaign" | "issueApproval"> = {
      getCampaign: async () => snapshot,
      issueApproval: async (_campaignId, _payload, _key, signal) => {
        approvalSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const view = render(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-click-0002"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request proposal/i }));

    view.unmount();

    expect(approvalSignal?.aborted).toBe(true);
  });

  it("does not carry an abort-ignoring POST lock across A-B-A navigation", async () => {
    const issueApproval = vi.fn<OpenQuestApi["issueApproval"]>(async () => new Promise(() => undefined));
    const getCampaign = vi.fn(async (id: string) => ({ ...snapshot, id }));
    const api = { getCampaign, issueApproval };
    const view = render(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-route-a"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    view.rerender(<CampaignPage api={api} campaignId="campaign-2" createIdempotencyKey={() => "approval-route-b"} />);
    view.rerender(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-route-a2"} />);

    const checkbox = await screen.findByRole("checkbox", { name: /reviewed every field/i });
    await waitFor(() => { expect(checkbox).toBeEnabled(); });
    expect(screen.queryByRole("button", { name: /issuing scoped approval/i })).not.toBeInTheDocument();
  });

  it("renders the refreshed durable approval after issuance", async () => {
    let reads = 0;
    const approved = { id: "approval-1", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:10:00Z", expiresAt: "2099-08-26T00:20:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    const api: Pick<OpenQuestApi, "getCampaign" | "issueApproval"> = {
      getCampaign: async () => ({ ...snapshot, approvals: reads++ === 0 ? [] : [approved] }),
      issueApproval: async () => approved,
    };
    render(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-refresh"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    expect(await screen.findByText("Pull request approval approved")).toBeVisible();
  });

  it("clears POST optimism and exposes refresh retry when the authoritative GET fails", async () => {
    const postApproval = { id: "approval-post", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2099-08-26T00:10:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    const getCampaign = vi.fn<OpenQuestApi["getCampaign"]>()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("refresh offline"))
      .mockResolvedValueOnce({ ...snapshot, approvals: [] });
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => postApproval }} campaignId="campaign-1" createIdempotencyKey={() => "approval-refresh-failure"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    expect(await screen.findByRole("alert", { name: /campaign facts refresh failed/i })).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: /owner\/repo/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry campaign refresh/i }));
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(3); });
    expect(screen.queryByRole("alert", { name: /campaign facts refresh failed/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve scoped pull request/i })).toBeEnabled();
  });

  it("expires POST optimism and bounds abort-ignoring authoritative refreshes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    const postApproval = { id: "approval-post-timeout", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2026-08-26T00:00:01Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    const lateApproval = { ...postApproval, expiresAt: "2026-08-26T00:10:00Z" };
    let resolveLateRefresh!: (value: CampaignSnapshot) => void;
    let firstRefreshSignal: AbortSignal | undefined;
    let retrySignal: AbortSignal | undefined;
    let reads = 0;
    const getCampaign = vi.fn<OpenQuestApi["getCampaign"]>(async (_campaignId, signal) => {
      reads += 1;
      if (reads === 1) return snapshot;
      if (reads === 2) return new Promise<CampaignSnapshot>((resolve) => { firstRefreshSignal = signal; resolveLateRefresh = resolve; });
      return new Promise<CampaignSnapshot>(() => { retrySignal = signal; });
    });
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => postApproval }} campaignId="campaign-1" createIdempotencyKey={() => "approval-refresh-timeout"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    expect(await screen.findByRole("button", { name: /scoped proposal approved/i })).toBeDisabled();
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(2); });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(firstRefreshSignal?.aborted).toBe(true);
    const retry = await screen.findByRole("button", { name: /retry campaign refresh/i });
    expect(retry).toBeEnabled();
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();

    resolveLateRefresh({ ...snapshot, approvals: [lateApproval] });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole("button", { name: /retry campaign refresh/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();

    fireEvent.click(retry);
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(3); });
    expect(retrySignal).not.toBe(firstRefreshSignal);
    expect(retrySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(retrySignal?.aborted).toBe(true);
    expect(await screen.findByRole("button", { name: /retry campaign refresh/i })).toBeEnabled();
  });

  it.each([
    ["inactive", { approvals: [{ id: "approval-inactive", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:10:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: false }] }],
    ["expired", { approvals: [{ id: "approval-expired", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2026-08-26T00:10:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: false }] }],
    ["absent", { approvals: [] }],
  ] as const)("clears POST optimism when the authoritative approval is %s", async (_label, refreshed) => {
    let reads = 0;
    const postApproval = { id: "approval-post", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2099-08-26T00:10:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    const getCampaign = vi.fn(async () => reads++ === 0 ? snapshot : { ...snapshot, ...refreshed });
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => postApproval }} campaignId="campaign-1" createIdempotencyKey={() => "approval-authority"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(2); });
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve scoped pull request/i })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /reviewed every field/i })).toBeEnabled();
  });

  it("follows a consumed authoritative snapshot without asking to approve a proposal that disappeared", async () => {
    let reads = 0;
    const postApproval = { id: "approval-post", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    const consumed = { ...postApproval, status: "consumed" as const, consumedAt: "2026-08-26T00:01:00Z", isActive: false };
    const getCampaign = vi.fn(async () => reads++ === 0 ? snapshot : { ...snapshot, approvalProposal: null, approvals: [consumed] });
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => postApproval }} campaignId="campaign-1" createIdempotencyKey={() => "approval-consumed"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    expect(await screen.findByText(/exact proposal is pending/i)).toBeVisible();
    expect(screen.getByText("Pull request approval consumed")).toBeVisible();
    expect(screen.queryByRole("button", { name: /approve scoped pull request/i })).not.toBeInTheDocument();
  });

  it("refreshes campaign approval availability when the server TTL expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    const expiring = { id: "approval-expiring", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-25T23:59:00Z", expiresAt: "2026-08-26T00:00:01Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    let reads = 0;
    const getCampaign = vi.fn(async () => ({ ...snapshot, approvals: reads++ === 0 ? [expiring] : [] }));
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => expiring }} campaignId="campaign-1" />);
    await screen.findByText(payload.title);
    expect(screen.getByRole("button", { name: /scoped proposal approved/i })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(1_001);

    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(2); });
    expect(screen.getByRole("button", { name: /approve scoped pull request/i })).toBeDisabled();
    vi.useRealTimers();
  });

  it("treats an expired snapshot as non-authoritative while refresh fails, then retries successfully", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    const expiring = { id: "approval-expiring-retry", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-25T23:59:00Z", expiresAt: "2026-08-26T00:00:01Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    let rejectRefresh!: (reason: Error) => void;
    const getCampaign = vi.fn<OpenQuestApi["getCampaign"]>()
      .mockResolvedValueOnce({ ...snapshot, approvals: [expiring] })
      .mockImplementationOnce(async () => new Promise<CampaignSnapshot>((_resolve, reject) => { rejectRefresh = reject; }))
      .mockResolvedValueOnce({ ...snapshot, approvals: [] });
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => expiring }} campaignId="campaign-1" />);
    await screen.findByText(payload.title);
    expect(screen.getByRole("button", { name: /scoped proposal approved/i })).toBeDisabled();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(await screen.findByRole("status", { name: /refreshing campaign facts/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();
    rejectRefresh(new Error("expiry refresh offline"));
    expect(await screen.findByRole("alert", { name: /campaign facts refresh failed/i })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /retry campaign refresh/i }));
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(3); });
    expect(screen.queryByRole("alert", { name: /campaign facts refresh failed/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();
  });

  it("immediately refreshes an already-expired active DTO once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:10:00Z"));
    const expired = { id: "approval-expired", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2026-08-26T00:09:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true };
    let reads = 0;
    const getCampaign = vi.fn(async () => ({ ...snapshot, approvals: reads++ === 0 ? [expired] : [] }));
    render(<CampaignPage api={{ getCampaign, issueApproval: async () => expired }} campaignId="campaign-1" />);
    await screen.findByText(payload.title);

    await vi.advanceTimersByTimeAsync(0);
    await waitFor(() => { expect(getCampaign).toHaveBeenCalledTimes(2); });
    expect(screen.queryByRole("button", { name: /scoped proposal approved/i })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("pauses an expiry refresh during approval and reconciles without invalidating the successful POST", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    let release!: (value: Awaited<ReturnType<OpenQuestApi["issueApproval"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<OpenQuestApi["issueApproval"]>>>((resolve) => { release = resolve; });
    const old = { id: "approval-old", action: "create_pr" as const, actionDigest: `sha256:${"c".repeat(64)}`, status: "approved" as const, issuedAt: "2026-08-25T23:59:00Z", expiresAt: "2026-08-26T00:00:01Z", proposalId: "proposal-old", expectedCampaignVersion: 6, isActive: true };
    const fresh = { ...old, id: "approval-fresh", actionDigest: proposal.actionDigest, proposalId: proposal.proposalId, expectedCampaignVersion: 7, issuedAt: "2026-08-26T00:00:01Z", expiresAt: "2026-08-26T00:10:01Z" };
    let reads = 0;
    const getCampaign = vi.fn(async () => ({ ...snapshot, approvals: reads++ === 0 ? [old] : [fresh] }));
    const issueApproval = vi.fn(async () => pending);
    render(<CampaignPage api={{ getCampaign, issueApproval }} campaignId="campaign-1" createIdempotencyKey={() => "approval-overlap"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    fireEvent.click(screen.getByRole("button", { name: /approve scoped pull request/i }));

    await vi.advanceTimersByTimeAsync(1_001);
    expect(getCampaign).toHaveBeenCalledTimes(1);
    release(fresh);
    await waitFor(() => { expect(getCampaign.mock.calls.length).toBeGreaterThanOrEqual(2); });
    expect(await screen.findByRole("button", { name: /scoped proposal approved/i })).toBeDisabled();
    vi.useRealTimers();
  });
});
