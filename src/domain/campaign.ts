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
  id: string;
  repository: string;
  issueNumber: number;
  issueUrl: string;
  parentSessionId: string;
  lane: "easy_win" | "long_term";
  status: CampaignStatus;
  qodoIteration: number;
  version: number;
}

const allowed: Record<CampaignStatus, readonly CampaignStatus[]> = {
  policy_review: ["coordination_pending", "preflight", "withdrawn"],
  coordination_pending: ["preflight", "withdrawn"],
  preflight: ["quarantined", "baseline", "withdrawn"],
  quarantined: ["preflight", "withdrawn"],
  baseline: ["implementation", "withdrawn"],
  implementation: ["verification", "withdrawn"],
  verification: ["implementation", "contribution_approval", "withdrawn"],
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
