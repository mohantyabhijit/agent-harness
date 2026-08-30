// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({
  ServerProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  SlotsProvider: ({ children }: PropsWithChildren) => <>{children}</>,
  Thread: () => null,
  TrueForgeUI: () => <div>TrueForge UI</div>,
  TrueFoundryChatProvider: ({ children, initialSessionId }: PropsWithChildren<{ initialSessionId?: string }>) => <><div>TrueForge session {initialSessionId}</div>{children}</>,
}));

import type { CampaignSnapshot, OpenQuestApi } from "../../src/web/api.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";

const snapshot: CampaignSnapshot = {
  issueBrief: null,
  fixExplanation: null,
  id: "campaign-1",
  repository: "owner/repo",
  issueNumber: 42,
  issueUrl: "https://github.com/owner/repo/issues/42",
  parentSessionId: "session-42",
  lane: "easy_win",
  status: "qodo_review",
  qodoIteration: 2,
  version: 8,
  nextAllowedAction: null,
  evidence: [{ id: "policy", sourceUrl: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md", retrievedAt: "2026-08-26T00:00:00Z", observation: "Maintainers require focused pull requests.", kind: "direct" }],
  events: [
    { id: "created", eventType: "campaign_created", occurredAt: "2026-08-26T00:00:00Z", sequence: 1, facts: {} },
    { id: "verified", eventType: "campaign_operation_completed", occurredAt: "2026-08-26T00:05:00Z", sequence: 2, facts: { operation: "verify", testsPassed: true } },
  ],
  approvals: [{ id: "approval-1", action: "create_pr", actionDigest: `sha256:${"b".repeat(64)}`, status: "consumed", issuedAt: "2026-08-26T00:06:00Z", consumedAt: "2026-08-26T00:07:00Z", isActive: false }],
  qodoFindings: [{ id: "finding-1", severity: "medium", status: "open", summary: "Handle the empty response.", sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r1", disposition: "Repair queued" }],
  externalReferences: [
    { kind: "commit", value: "a".repeat(40) },
    { kind: "sandbox", value: "sandbox-7" },
    { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" },
  ],
  externalActionClaims: [],
  approvalProposal: null,
  qualityEscalationReason: null,
};

function campaignApi(getCampaign: OpenQuestApi["getCampaign"]): Pick<OpenQuestApi, "getCampaign" | "runCampaignAction" | "issueApproval"> {
  return { getCampaign, runCampaignAction: async () => { throw new Error("No operation should be available in this fixture"); }, issueApproval: async () => { throw new Error("No proposal should be approvable"); } };
}

describe("CampaignPage", () => {
  afterEach(cleanup);

  it("resumes the parent session and renders durable campaign facts without duplicating chat", async () => {
    render(<CampaignPage api={campaignApi(async () => snapshot)} campaignId="campaign-1" />);

    expect(await screen.findByTestId("agent-thread")).toHaveAttribute("data-session-id", "session-42");
    await waitFor(() => { expect(screen.getByRole("heading", { level: 1, name: /owner\/repo/i })).toHaveFocus(); });
    expect(screen.getByText("Maintainers require focused pull requests.")).toBeVisible();
    expect(screen.getByText("Campaign created")).toBeVisible();
    expect(screen.getByText("verify")).toBeVisible();
    expect(screen.getByText("true")).toBeVisible();
    expect(screen.getByText("Pull request approval consumed")).toBeVisible();
    expect(screen.getByText("Iteration 2 of 3")).toBeVisible();
    expect(screen.getByText("Handle the empty response.")).toBeVisible();
    expect(screen.getByText(/proposal is pending/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: /awaiting the next verified state/i })).toBeVisible();
    expect(screen.queryByText(/chat transcript/i)).not.toBeInTheDocument();
  });

  it("renders the backend brief and unlocks preflight only after explicit finalization", async () => {
    const issueBrief = {
      problem: "The issue describes an incorrect boundary result.", likelyCause: "A documented guard is missing.", smallestFix: "Add the guard and regression test.",
      affectedAreas: ["src/boundary.ts"], tests: ["Run the regression test."], risks: ["Invalid callers may surface."], uncertainty: "Call sites require sandbox inspection.",
      evidence: [{ sourceUrl: "https://github.com/owner/repo/issues/42", observation: "The issue documents expected behavior." }],
    };
    const before = { ...snapshot, issueBrief, status: "policy_review" as const, version: 1, nextAllowedAction: null };
    const after = { ...before, status: "coordination_pending" as const, version: 2, nextAllowedAction: "preflight" as const };
    const getCampaign = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const finalizeCampaign = vi.fn(async () => ({ ...after }));

    render(<CampaignPage api={{ getCampaign, finalizeCampaign, issueApproval: async () => { throw new Error("No approval should be issued"); }, runCampaignAction: async () => { throw new Error("Preflight is not run in this test"); } }} campaignId="campaign-1" createFinalizationKey={() => "finalize-component"} />);

    expect(await screen.findByRole("heading", { name: /problem and proposed fix/i })).toBeVisible();
    expect(screen.getByText(issueBrief.smallestFix)).toBeVisible();
    expect(screen.queryByRole("button", { name: /start static preflight/i })).not.toBeInTheDocument();
    screen.getByRole("button", { name: /finalize issue brief/i }).click();
    await waitFor(() => { expect(finalizeCampaign).toHaveBeenCalledWith("campaign-1", 1, "finalize-component", expect.any(AbortSignal)); });
    expect(await screen.findByRole("button", { name: /start static preflight/i })).toBeVisible();
    expect(screen.getByText(/finalized/i)).toBeVisible();
  });

  it("aborts its in-flight campaign read when the page unmounts", () => {
    let observedSignal: AbortSignal | undefined;
    const view = render(<CampaignPage api={campaignApi(async (_id, signal) => {
      observedSignal = signal;
      return new Promise<CampaignSnapshot>(() => undefined);
    })} campaignId="campaign-1" />);

    view.unmount();

    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts a retried campaign read when the page unmounts", async () => {
    let attempts = 0;
    let retrySignal: AbortSignal | undefined;
    const view = render(<CampaignPage api={campaignApi(async (_id, signal) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      retrySignal = signal;
      return new Promise<CampaignSnapshot>(() => undefined);
    })} campaignId="campaign-1" />);
    const retry = await screen.findByRole("button", { name: /try again/i });

    retry.click();
    view.unmount();

    expect(retrySignal?.aborted).toBe(true);
  });

  it("keeps a campaign action locked until its authoritative refresh succeeds", async () => {
    let releaseRefresh: ((value: CampaignSnapshot) => void) | undefined;
    const afterAction = { ...snapshot, status: "implementation" as const, version: 9, nextAllowedAction: null };
    const getCampaign = vi.fn()
      .mockResolvedValueOnce({ ...snapshot, status: "baseline" as const, nextAllowedAction: "implement" as const })
      .mockImplementationOnce(() => new Promise<CampaignSnapshot>((resolve) => { releaseRefresh = resolve; }));
    const runCampaignAction = vi.fn(async () => ({ ...snapshot, status: "implementation" as const, version: 9 }));

    render(<CampaignPage api={{ getCampaign, issueApproval: async () => { throw new Error("No approval should be issued"); }, runCampaignAction }} campaignId="campaign-1" />);

    const action = await screen.findByRole("button", { name: /run isolated implementation/i });
    action.click();
    await waitFor(() => { expect(runCampaignAction).toHaveBeenCalledWith("campaign-1", "implement", expect.any(AbortSignal)); });
    expect(action).toBeDisabled();
    expect(screen.getByLabelText(/refreshing campaign facts/i)).toBeVisible();

    releaseRefresh?.(afterAction);
    expect(await screen.findByRole("heading", { name: /awaiting the next verified state/i })).toBeVisible();
  });

  it("does not resurrect route-scoped state across an A-B-A navigation when promises ignore abort", async () => {
    const releases = new Map<string, (value: CampaignSnapshot) => void>();
    const getCampaign = vi.fn((id: string) => new Promise<CampaignSnapshot>((resolve) => { releases.set(`${id}-${String(getCampaign.mock.calls.length)}`, resolve); }));
    const view = render(<CampaignPage api={campaignApi(getCampaign)} campaignId="campaign-1" />);
    view.rerender(<CampaignPage api={campaignApi(getCampaign)} campaignId="campaign-2" />);
    view.rerender(<CampaignPage api={campaignApi(getCampaign)} campaignId="campaign-1" />);
    releases.get("campaign-1-1")?.({ ...snapshot, parentSessionId: "stale-session" });
    expect(screen.queryByText("stale-session")).not.toBeInTheDocument();
    releases.get("campaign-1-3")?.({ ...snapshot, parentSessionId: "fresh-session" });
    expect(await screen.findByText("TrueForge session fresh-session")).toBeVisible();
  });

  it("renders the durable typed escalation reason instead of inferring from findings", async () => {
    render(<CampaignPage api={campaignApi(async () => ({ ...snapshot, status: "human_escalation", qodoIteration: 3, qualityEscalationReason: "tests_failed" }))} campaignId="campaign-1" />);
    expect(await screen.findByText(/durable quality record says verification tests failed/i)).toBeVisible();
    expect(screen.queryByText(/repair limit was reached/i)).not.toBeInTheDocument();
  });

  it("shows the durable before-and-after fix explanation beside the resumed agent", async () => {
    render(<CampaignPage api={campaignApi(async () => ({ ...snapshot, fixExplanation: {
      commitSha: "b".repeat(40),
      before: "The boundary returned the wrong result.",
      after: "The boundary now handles the documented case.",
      changedAreas: ["src/boundary.ts"],
      tests: ["npm test -- boundary"],
      uncertainty: "No known uncertainty remains.",
    } }))} campaignId="campaign-1" />);

    expect(await screen.findByRole("heading", { name: /what changed and why/i })).toBeVisible();
    expect(screen.getByText("The boundary returned the wrong result.")).toBeVisible();
    expect(screen.getByText("The boundary now handles the documented case.")).toBeVisible();
    expect(screen.getByText("src/boundary.ts")).toBeVisible();
    expect(screen.getByText("TrueForge session session-42")).toBeVisible();
  });

  it("uses durable sequence, not descending timestamps, for event causality", async () => {
    render(<CampaignPage api={campaignApi(async () => ({ ...snapshot, approvals: [], events: [
      { id: "first", eventType: "campaign_created", occurredAt: "2026-08-26T00:10:00Z", sequence: 1, facts: {} },
      { id: "second", eventType: "campaign_operation_completed", occurredAt: "2026-08-26T00:00:00Z", sequence: 2, facts: { operation: "verify" } },
    ] }))} campaignId="campaign-1" />);
    await screen.findByTestId("agent-thread");
    const entries = screen.getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("Campaign created");
    expect(entries[1]).toHaveTextContent("Campaign operation completed");
  });

  it("labels a reconciled external action with its validated disposition", async () => {
    render(<CampaignPage api={campaignApi(async () => ({ ...snapshot, approvals: [], events: [
      { id: "reconciled", eventType: "external_action_reconciled", occurredAt: "2026-08-26T00:10:00Z", sequence: 1, facts: { action: "create_pr", disposition: "confirmed_completed", observedCanonicalHead: "b".repeat(40) } },
    ] }))} campaignId="campaign-1" />);

    expect(await screen.findByText("External action confirmed completed")).toBeVisible();
    expect(screen.getByText(/observed canonical head/i)).toBeVisible();
  });
});
