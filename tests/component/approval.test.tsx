// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@truefoundry/trueforge-ui", () => ({ TrueForgeUI: () => <div /> }));

import type { ApprovalProposal, CampaignSnapshot, ExternalActionPayload, OpenQuestApi } from "../../src/web/api.js";
import { ChangeBrief } from "../../src/web/components/ChangeBrief.js";
import { CampaignPage } from "../../src/web/routes/CampaignPage.js";

const payload: ExternalActionPayload = {
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
  payload,
  actionDigest: `sha256:${"b".repeat(64)}`,
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
  evidence: [], events: [], approvals: [], qodoFindings: [], externalReferences: [{ kind: "commit", value: "a".repeat(40) }], externalActionClaims: [], approvalProposal: proposal,
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
    expect(approve).toHaveBeenCalledWith(payload);
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
    const api = { getCampaign: async () => snapshot, issueApproval };
    render(<CampaignPage api={api} campaignId="campaign-1" createIdempotencyKey={() => "approval-click-0001"} />);
    await screen.findByText(payload.title);
    fireEvent.click(screen.getByRole("checkbox", { name: /reviewed every field/i }));
    const button = screen.getByRole("button", { name: /approve scoped pull request proposal/i });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(issueApproval).toHaveBeenCalledOnce();
    expect(issueApproval).toHaveBeenCalledWith("campaign-1", payload, "approval-click-0001", expect.any(AbortSignal));
    const key = issueApproval.mock.calls[0]?.[2] ?? "";
    expect(key).toMatch(/^[\x21-\x7e]{8,128}$/u);
    release();
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
});
