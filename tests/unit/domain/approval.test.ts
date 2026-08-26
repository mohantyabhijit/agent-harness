import { describe, expect, it } from "vitest";
import { consumeApproval, issueApproval } from "../../../src/domain/approval.js";

describe("scoped approvals", () => {
  it("is single-use and bound to the exact action digest", () => {
    const approval = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z" });
    expect(consumeApproval(approval, "sha256:a").status).toBe("consumed");
    expect(() => consumeApproval(approval, "sha256:b")).toThrow(/does not match/i);
  });
});
