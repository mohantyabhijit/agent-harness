export type ApprovalAction =
  | "post_issue_comment"
  | "request_assignment"
  | "push_branch"
  | "create_pr"
  | "update_pr";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface Approval {
  id: string;
  campaignId: string;
  action: ApprovalAction;
  actionDigest: string;
  status: ApprovalStatus;
  issuedAt: string;
  expiresAt?: string;
  consumedAt?: string;
}

export function issueApproval(input: Omit<Approval, "status">): Approval {
  return { ...input, status: "approved" };
}

export function consumeApproval(
  approval: Approval,
  actionDigest: string,
  consumedAt = new Date().toISOString(),
): Approval {
  if (approval.actionDigest !== actionDigest) {
    throw new Error("Approval does not match this action");
  }
  if (approval.status !== "approved") {
    throw new Error("Approval is not available");
  }
  if (approval.expiresAt && approval.expiresAt <= consumedAt) {
    throw new Error("Approval expired");
  }

  return { ...approval, status: "consumed", consumedAt };
}
