import { z } from "zod";

import { canonicalExternalActionJson, externalActionDigest, validateExternalActionPayload, type ExternalActionPayload } from "./external-action.js";
import type { CampaignSnapshot } from "./ports/campaign-store.js";
import type { CampaignStatus } from "../domain/campaign.js";
import { isApprovalActionAllowed } from "../domain/approval.js";

const text = z.string().trim().min(1).max(20_000);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const sha = z.string().regex(/^[0-9a-f]{40}$/u);

export interface ApprovalBrief {
  readonly policy: string;
  readonly approach: string;
  readonly files: readonly string[];
  readonly risks: readonly string[];
  readonly tests: readonly string[];
  readonly safetyResult: string;
  readonly qodoStatus: string;
  readonly aiDisclosure: string;
}

export interface DurableApprovalProposal {
  readonly proposalId: string;
  readonly payload: ExternalActionPayload;
  readonly actionDigest: string;
  readonly expectedCampaignVersion: number;
  readonly expectedCampaignStatus: CampaignStatus;
  readonly expectedCurrentCommitSha?: string;
  readonly brief: ApprovalBrief;
}

const proposalSchema = z.object({
  proposalId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
  payload: z.custom<ExternalActionPayload>((value) => { try { validateExternalActionPayload(value as ExternalActionPayload); return true; } catch { return false; } }),
  actionDigest: digest,
  expectedCampaignVersion: z.number().int().positive(),
  expectedCampaignStatus: z.string().trim().min(1).max(64),
  expectedCurrentCommitSha: sha.optional(),
  brief: z.object({
    policy: text, approach: text, files: z.array(text).min(1).max(200), risks: z.array(text).min(1).max(200),
    tests: z.array(text).min(1).max(200), safetyResult: text, qodoStatus: text, aiDisclosure: text,
  }).strict(),
}).strict();

export function currentApprovalProposal(snapshot: CampaignSnapshot): DurableApprovalProposal | null {
  if (!hasValidEventSequence(snapshot)) return null;
  if (snapshot.externalActionClaims.some(({ status }) => status === "active" || status === "outcome_unknown")) return null;
  const newest = snapshot.events
    .filter(({ eventType }) => eventType === "external_action_proposed")
    .toSorted((left, right) => right.sequence - left.sequence)[0];
  if (newest === undefined) return null;
  const parsed = proposalSchema.safeParse(newest.payload);
  if (!parsed.success || parsed.data.proposalId !== newest.id) return null;
  const proposal = parsed.data as DurableApprovalProposal;
  const { payload } = proposal;
  const currentCommit = singleton(snapshot, "commit");
  if (snapshot.approvals.some((approval) => consumedApprovalMatchesProposal(approval, proposal, snapshot.campaign.id))) return null;
  if (
    proposal.actionDigest !== externalActionDigest(payload) ||
    proposal.expectedCampaignVersion !== snapshot.campaign.version ||
    proposal.expectedCampaignStatus !== snapshot.campaign.status ||
    payload.repository !== snapshot.campaign.repository || payload.issueNumber !== snapshot.campaign.issueNumber ||
    !isApprovalActionAllowed(payload.action, snapshot.campaign.status) ||
    proposal.expectedCurrentCommitSha !== currentCommit ||
    (payload.action === "push_branch" && currentCommit === undefined)
  ) return null;
  if ((payload.action === "create_pr" || payload.action === "update_pr") && payload.commitSha !== currentCommit) return null;
  if (payload.action === "update_pr" && singleton(snapshot, "pull_request") !== payload.pullRequest) return null;
  return proposal;
}

function consumedApprovalMatchesProposal(approval: CampaignSnapshot["approvals"][number], proposal: DurableApprovalProposal, campaignId: string): boolean {
  if (approval.status !== "consumed" || approval.trustedProposalAuthority !== true || approval.payload === undefined) return false;
  try {
    return approval.campaignId === campaignId && approval.proposalId === proposal.proposalId &&
      approval.action === proposal.payload.action && approval.actionDigest === proposal.actionDigest &&
      approval.expectedCampaignVersion === proposal.expectedCampaignVersion && approval.expectedCampaignStatus === proposal.expectedCampaignStatus &&
      approval.expectedCurrentCommitSha === (proposal.expectedCurrentCommitSha ?? null) &&
      canonicalExternalActionJson(approval.payload as ExternalActionPayload) === canonicalExternalActionJson(proposal.payload);
  } catch {
    return false;
  }
}

function hasValidEventSequence(snapshot: CampaignSnapshot): boolean {
  const seen = new Set<number>();
  for (const event of snapshot.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || seen.has(event.sequence)) return false;
    seen.add(event.sequence);
  }
  return true;
}

function singleton(snapshot: CampaignSnapshot, kind: "commit" | "pull_request"): string | undefined {
  const values = snapshot.externalReferences.filter((reference) => reference.kind === kind);
  return values.length === 1 ? values[0]?.value : undefined;
}

export function proposalActionSummary(payload: ExternalActionPayload, sourceCommitSha?: string): Readonly<Record<string, unknown>> {
  const common = { action: payload.action, repository: payload.repository, issueNumber: payload.issueNumber };
  switch (payload.action) {
    case "post_issue_comment": return { ...common, body: payload.body };
    case "request_assignment": return { ...common, assignee: payload.assignee };
    case "push_branch": return { ...common, branch: payload.branch, sourceCommitSha, targetCommitSha: payload.commitSha };
    case "create_pr": return { ...common, branch: payload.branch, baseBranch: payload.baseBranch, commitSha: payload.commitSha, title: payload.title, body: payload.body };
    case "update_pr": return { ...common, pullRequest: payload.pullRequest, branch: payload.branch, commitSha: payload.commitSha, body: payload.body };
  }
}
