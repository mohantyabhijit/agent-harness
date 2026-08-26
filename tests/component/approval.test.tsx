// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({ TrueForgeUI: () => <div /> }));

import type { ApprovalActionSummary, ApprovalProposal, CampaignSnapshot, OpenQuestApi } from "../../src/web/api.js";
import { ChangeBrief } from "../../src/web/components/ChangeBrief.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";

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
  id: "campaign-1", repository: "owner/repo", issueNumber: 42, issueUrl: "https://github.com/owner/repo/issues/42", parentSessionId: "session-42", lane: "easy_win", status: "contribution_approval", qodoIteration: 0, version: 7,
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
});

describe("Campaign approval", () => {
  afterEach(cleanup);

  it("generates one bounded visible-ASCII key per explicit click and prevents double submission", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const issueApproval = vi.fn<OpenQuestApi["issueApproval"]>(async () => {
      await pending;
      return { id: "approval-1", action: "create_pr", actionDigest: proposal.actionDigest, status: "approved", issuedAt: "2026-08-26T00:10:00Z" };
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

  it("renders the refreshed durable approval after issuance", async () => {
    let reads = 0;
    const approved = { id: "approval-1", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-26T00:10:00Z", expiresAt: "2099-08-26T00:20:00Z" };
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

  it("refreshes campaign approval availability when the server TTL expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-26T00:00:00Z"));
    const expiring = { id: "approval-expiring", action: "create_pr" as const, actionDigest: proposal.actionDigest, status: "approved" as const, issuedAt: "2026-08-25T23:59:00Z", expiresAt: "2026-08-26T00:00:01Z" };
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
});
