// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({ TrueForgeUI: ({ initialSessionId }: { initialSessionId?: string }) => <div>TrueForge session {initialSessionId}</div> }));

import { OpenQuestApiError, type CampaignSnapshot, type OpenQuestApi } from "../../src/web/api.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";

const target = "b".repeat(40);
const digest = `sha256:${"c".repeat(64)}`;
const action = { action: "create_pr" as const, repository: "owner/repo", issueNumber: 42, branch: "openquest/fix-42", baseBranch: "main", commitSha: target, title: "Fix issue 42", body: "Fixes https://github.com/owner/repo/issues/42\nVerified tests: npm test\nRisks: low\nRollback: revert the commit\nAI disclosure: TrueForge assisted this change." };
const proposal = { proposalId: "proposal-publication", actionDigest: digest, expectedCampaignVersion: 7, action, brief: { policy: "Open focused changes only.", approach: "Add the smallest regression fix.", files: ["src/fix.ts"], risks: ["A caller may rely on the old behavior."], tests: ["npm test"], safetyResult: "Static preflight passed.", qodoStatus: "No unresolved high findings.", aiDisclosure: "TrueForge assisted implementation; a human reviews the exact action." } };

function snapshot(approval: CampaignSnapshot["approvals"][number] | undefined = { id: "approval-publication", action: "create_pr", actionDigest: digest, status: "approved", issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2099-08-26T00:00:00Z", proposalId: proposal.proposalId, expectedCampaignVersion: 7, isActive: true }): CampaignSnapshot {
  return { id: "campaign-1", repository: "owner/repo", issueNumber: 42, issueUrl: "https://github.com/owner/repo/issues/42", parentSessionId: "session-42", lane: "easy_win", status: "contribution_approval", qodoIteration: 0, version: 7, nextAllowedAction: null, issueBrief: null, fixExplanation: null, evidence: [], events: [], approvals: [approval], qodoFindings: [], externalReferences: [{ kind: "commit", value: target }], externalActionClaims: [], approvalProposal: proposal, qualityEscalationReason: null };
}

function baseApi(getCampaign: OpenQuestApi["getCampaign"], publishApprovedAction?: OpenQuestApi["publishApprovedAction"]): Pick<OpenQuestApi, "getCampaign" | "issueApproval"> & Partial<Pick<OpenQuestApi, "publishApprovedAction">> {
  return { getCampaign, issueApproval: async () => { throw new Error("Approval is not part of this test"); }, ...(publishApprovedAction === undefined ? {} : { publishApprovedAction }) };
}

describe("Campaign publication UX", () => {
  afterEach(cleanup);

  it("keeps approval and execution visibly separate, sends the active approval, then shows the canonical PR", async () => {
    const getCampaign = vi.fn(async () => snapshot());
    const publishApprovedAction = vi.fn(async () => ({ pullRequest: "https://github.com/owner/repo/pull/17" }));
    render(<CampaignPage api={baseApi(getCampaign, publishApprovedAction)} campaignId="campaign-1" />);

    expect(await screen.findByRole("heading", { name: /exact external action/i })).toBeVisible();
    expect(screen.getByText(/it does not push a branch or create a github pull request/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: /execute approved action/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /create approved pull request/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /create approved pull request/i }));
    await waitFor(() => { expect(publishApprovedAction).toHaveBeenCalledWith("campaign-1", "approval-publication", action, expect.any(AbortSignal)); });
    expect(await screen.findByText(/pull request opened/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /view canonical pull request/i })).toHaveAttribute("href", "https://github.com/owner/repo/pull/17");
  });

  it("fails closed when publication outcome is unknown and does not offer an unsafe retry", async () => {
    const publishApprovedAction = vi.fn(async () => { throw new OpenQuestApiError("Publication outcome is unknown; reconciliation is required", 409, "publication_outcome_unknown"); });
    render(<CampaignPage api={baseApi(async () => snapshot(), publishApprovedAction)} campaignId="campaign-1" />);

    fireEvent.click(await screen.findByRole("button", { name: /create approved pull request/i }));
    expect(await screen.findByText(/publication outcome unknown/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /create approved pull request/i })).not.toBeInTheDocument();
  });

  it("locks execution when the approval does not match the current server proposal", async () => {
    const currentApproval = snapshot().approvals[0];
    if (currentApproval === undefined) throw new Error("fixture approval missing");
    const inactive = { ...currentApproval, isActive: false };
    render(<CampaignPage api={baseApi(async () => snapshot(inactive))} campaignId="campaign-1" />);

    expect(await screen.findByText(/execution is locked until this exact proposal has an active approval/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /create approved pull request/i })).not.toBeInTheDocument();
  });
});
