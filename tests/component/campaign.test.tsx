// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    { id: "created", eventType: "campaign_created", occurredAt: "2026-08-26T00:00:00Z" },
    { id: "verified", eventType: "campaign_operation_completed", occurredAt: "2026-08-26T00:05:00Z" },
  ],
  approvals: [{ id: "approval-1", action: "create_pr", actionDigest: `sha256:${"b".repeat(64)}`, status: "consumed", issuedAt: "2026-08-26T00:06:00Z", consumedAt: "2026-08-26T00:07:00Z" }],
  qodoFindings: [{ id: "finding-1", severity: "medium", status: "open", summary: "Handle the empty response.", sourceUrl: "https://github.com/owner/repo/pull/7#discussion_r1", disposition: "Repair queued" }],
  externalReferences: [
    { kind: "commit", value: "a".repeat(40) },
    { kind: "sandbox", value: "sandbox-7" },
    { kind: "pull_request", value: "https://github.com/owner/repo/pull/7" },
  ],
  externalActionClaims: [],
  approvalProposal: null,
};

function campaignApi(getCampaign: OpenQuestApi["getCampaign"]): Pick<OpenQuestApi, "getCampaign" | "issueApproval"> {
  return { getCampaign, issueApproval: async () => { throw new Error("No proposal should be approvable"); } };
}

describe("CampaignPage", () => {
  afterEach(cleanup);

  it("resumes the parent session and renders durable campaign facts without duplicating chat", async () => {
    render(<CampaignPage api={campaignApi(async () => snapshot)} campaignId="campaign-1" />);

    expect(await screen.findByTestId("agent-thread")).toHaveAttribute("data-session-id", "session-42");
    expect(screen.getByText("Maintainers require focused pull requests.")).toBeVisible();
    expect(screen.getByText("Campaign created")).toBeVisible();
    expect(screen.getByText("Pull request approval consumed")).toBeVisible();
    expect(screen.getByText("Iteration 2 of 3")).toBeVisible();
    expect(screen.getByText("Handle the empty response.")).toBeVisible();
    expect(screen.getByText(/proposal is pending/i)).toBeVisible();
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
});
