import { describe, expect, it } from "vitest";
import { transitionCampaign, type Campaign } from "../../../src/domain/campaign.js";

const campaign: Campaign = {
  id: "campaign-1",
  repository: "owner/repo",
  issueNumber: 42,
  issueUrl: "https://github.com/owner/repo/issues/42",
  parentSessionId: "session-1",
  lane: "easy_win",
  status: "policy_review",
  qodoIteration: 0,
  version: 1,
};

describe("transitionCampaign", () => {
  it("allows policy review to advance to preflight", () => {
    expect(transitionCampaign(campaign, "preflight").status).toBe("preflight");
  });

  it("rejects skipping preflight", () => {
    expect(() => transitionCampaign(campaign, "implementation")).toThrow(/invalid campaign transition/i);
  });
});
