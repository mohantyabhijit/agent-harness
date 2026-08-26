import { describe, expect, it } from "vitest";
import {
  consumeApproval,
  isApprovalActionAllowed,
  issueApproval,
} from "../../../src/domain/approval.js";

function verifyApprovalIsReadonly(approval: ReturnType<typeof issueApproval>): void {
  // @ts-expect-error Approval fields are immutable outside domain transitions.
  approval.status = "consumed";
}

describe("scoped approvals", () => {
  it("allows each write only in its exact campaign phase", () => {
    expect(isApprovalActionAllowed("post_issue_comment", "coordination_pending")).toBe(true);
    expect(isApprovalActionAllowed("request_assignment", "coordination_pending")).toBe(true);
    expect(isApprovalActionAllowed("push_branch", "contribution_approval")).toBe(true);
    expect(isApprovalActionAllowed("create_pr", "contribution_approval")).toBe(true);
    expect(isApprovalActionAllowed("update_pr", "repair")).toBe(true);
    expect(isApprovalActionAllowed("create_pr", "quarantined")).toBe(false);
    expect(isApprovalActionAllowed("update_pr", "human_escalation")).toBe(false);
    expect(isApprovalActionAllowed("post_issue_comment", "withdrawn")).toBe(false);
  });

  it("is single-use and bound to the exact action digest", () => {
    const approval = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z" });
    expect(consumeApproval(approval, "sha256:a").status).toBe("consumed");
    expect(() => consumeApproval(approval, "sha256:b")).toThrow(/does not match/i);
  });

  it("rejects reuse of a consumed approval", () => {
    const approval = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z" });
    const consumed = consumeApproval(approval, "sha256:a", "2026-08-26T00:01:00Z");

    expect(() => consumeApproval(consumed, "sha256:a")).toThrow(/not available/i);
  });

  it("uses timestamp instants rather than lexical ordering for expiry", () => {
    const approval = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z", expiresAt: "2026-08-26T01:00:00+01:00" });

    expect(() => consumeApproval(approval, "sha256:a", "2026-08-26T00:30:00Z")).toThrow(/expired/i);
  });

  it("rejects invalid expiry and consumption timestamps", () => {
    const invalidExpiry = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z", expiresAt: "not-a-timestamp" });
    const approval = issueApproval({ id: "approval-2", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:00:00Z" });

    expect(() => consumeApproval(invalidExpiry, "sha256:a", "2026-08-26T00:01:00Z")).toThrow(/invalid expiry timestamp/i);
    expect(() => consumeApproval(approval, "sha256:a", "not-a-timestamp")).toThrow(/invalid consumption timestamp/i);
  });

  it("rejects consumption before the approval was issued", () => {
    const approval = issueApproval({ id: "approval-1", campaignId: "campaign-1", action: "create_pr", actionDigest: "sha256:a", issuedAt: "2026-08-26T00:10:00Z" });

    expect(() => consumeApproval(approval, "sha256:a", "2026-08-26T00:09:59Z")).toThrow(/before.*issued|issued.*after/i);
  });

  it("exposes approval data as immutable value-object fields", () => {
    expect(verifyApprovalIsReadonly).toBeTypeOf("function");
  });
});
