export type ApprovalAction =
  | "post_issue_comment"
  | "request_assignment"
  | "push_branch"
  | "create_pr"
  | "update_pr";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed";

export interface Approval {
  readonly id: string;
  readonly campaignId: string;
  readonly action: ApprovalAction;
  readonly actionDigest: string;
  readonly status: ApprovalStatus;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly consumedAt?: string;
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
  const consumedAtInstant = parseTimestamp(consumedAt, "consumption");

  if (
    approval.expiresAt &&
    parseTimestamp(approval.expiresAt, "expiry") <= consumedAtInstant
  ) {
    throw new Error("Approval expired");
  }

  return { ...approval, status: "consumed", consumedAt };
}

function parseTimestamp(timestamp: string, label: "consumption" | "expiry"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(timestamp);
  if (!match) {
    throw new Error(`Invalid ${label} timestamp`);
  }

  const [, year, month, day] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  const instant = Date.parse(timestamp);
  if (Number(day) > daysInMonth || !Number.isFinite(instant)) {
    throw new Error(`Invalid ${label} timestamp`);
  }

  return instant;
}
