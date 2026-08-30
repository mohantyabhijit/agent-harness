// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({
  TrueForgeUI: ({ initialSessionId }: { initialSessionId?: string }) => <div>TrueForge session {initialSessionId}</div>,
}));

import type { CampaignSnapshot, OpenQuestApi } from "../../src/web/api.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";

const snapshot: CampaignSnapshot = {
  id: "campaign-1",
  repository: "owner/repo",
  issueNumber: 42,
  issueUrl: "https://github.com/owner/repo/issues/42",
  parentSessionId: "session-42",
  lane: "easy_win",
  status: "qodo_review",
  qodoIteration: 2,
  version: 8,
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
