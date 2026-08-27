export type CampaignStatus =
  | "policy_review"
  | "coordination_pending"
  | "preflight"
  | "quarantined"
  | "baseline"
  | "implementation"
  | "verification"
  | "contribution_approval"
  | "pull_request_open"
  | "qodo_review"
  | "repair"
  | "human_escalation"
  | "merged"
  | "closed"
  | "withdrawn";

export interface Campaign {
  readonly id: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly parentSessionId: string;
  readonly lane: "easy_win" | "long_term";
  readonly status: CampaignStatus;
  readonly qodoIteration: number;
  readonly version: number;
}

const allowed: Record<CampaignStatus, readonly CampaignStatus[]> = {
  policy_review: ["coordination_pending", "preflight", "withdrawn"],
  coordination_pending: ["preflight", "withdrawn"],
  preflight: ["quarantined", "baseline", "withdrawn"],
  quarantined: ["preflight", "withdrawn"],
  baseline: ["implementation", "withdrawn"],
  implementation: ["verification", "human_escalation", "withdrawn"],
  verification: ["implementation", "contribution_approval", "human_escalation", "withdrawn"],
  contribution_approval: ["pull_request_open", "withdrawn"],
  pull_request_open: ["qodo_review", "closed", "merged"],
  qodo_review: ["repair", "human_escalation", "merged", "closed"],
  repair: ["qodo_review", "human_escalation", "withdrawn"],
  human_escalation: ["repair", "withdrawn", "closed", "merged"],
  merged: [],
  closed: [],
  withdrawn: [],
};

export function transitionCampaign(campaign: Campaign, next: CampaignStatus): Campaign {
  if (!allowed[campaign.status].includes(next)) {
    throw new Error(`Invalid campaign transition: ${campaign.status} -> ${next}`);
  }

  return { ...campaign, status: next, version: campaign.version + 1 };
}
