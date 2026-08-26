import { ApplicationError } from "./errors.js";
import { isPullRequest } from "./external-action.js";
import type { CampaignSnapshot, CampaignStore } from "./ports/campaign-store.js";
import type { CampaignPacket, HarnessRequestOptions } from "./ports/harness.js";
import type { QodoReviewLocator, QodoReviewPort } from "./ports/qodo-review.js";
import type { QodoReviewBatch, ReviewExecutionContext, SyncReview } from "./sync-review.js";

export class SyncAuthenticatedReview {
  constructor(
    private readonly store: CampaignStore,
    private readonly review: QodoReviewPort,
    private readonly syncReview: Pick<SyncReview, "execute">,
  ) {}

  async execute(campaignId: string, locator: QodoReviewLocator, options?: ReviewExecutionContext) {
    options?.persistenceLease?.assertCurrent();
    const snapshot = await this.store.get(campaignId);
    if (snapshot === undefined) throw new ApplicationError("campaign_not_found");
    const batch = await authenticatedReviewBatch(this.review, snapshot, options, locator);
    options?.persistenceLease?.assertCurrent();
    return this.syncReview.execute(campaignId, batch, options);
  }
}

export async function authenticatedReviewBatch(
  reviewPort: QodoReviewPort,
  snapshot: CampaignSnapshot,
  options?: HarnessRequestOptions,
  locator?: QodoReviewLocator,
): Promise<QodoReviewBatch> {
  const pullRequest = singletonReference(snapshot, "pull_request");
  const commitSha = singletonReference(snapshot, "commit");
  const review = await reviewPort.getReview(
    snapshot.campaign.repository,
    parsePullRequestNumber(pullRequest, snapshot.campaign.repository),
    { packet: reviewPacket(snapshot, pullRequest, commitSha), ...options, ...(locator === undefined ? {} : { locator }) },
  );
  return {
    campaignId: snapshot.campaign.id,
    syncSessionId: review.syncSessionId,
    pullRequest,
    reviewId: review.reviewId,
    reviewUrl: review.reviewUrl,
    sourceIdentity: review.sourceIdentity,
    sourceReceipt: review.sourceReceipt,
    commitSha: review.commitSha,
    testsPassed: review.testsPassed,
    complete: review.complete,
    findings: review.findings,
  };
}

function singletonReference(snapshot: CampaignSnapshot, kind: "pull_request" | "commit"): string {
  const references = snapshot.externalReferences.filter((reference) => reference.kind === kind);
  if (references.length !== 1 || references[0] === undefined) throw new ApplicationError("campaign_conflict");
  return references[0].value;
}

function parsePullRequestNumber(pullRequest: string, repository: string): number {
  if (!isPullRequest(pullRequest, repository)) throw new ApplicationError("campaign_conflict");
  const pullRequestNumber = Number(pullRequest.slice(pullRequest.lastIndexOf("/") + 1));
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new ApplicationError("campaign_conflict");
  return pullRequestNumber;
}

function reviewPacket(snapshot: CampaignSnapshot, pullRequest: string, commitSha: string): CampaignPacket {
  return {
    campaignId: snapshot.campaign.id,
    repository: snapshot.campaign.repository,
    issueNumber: snapshot.campaign.issueNumber,
    goal: `Synchronize Qodo review iteration ${String(snapshot.campaign.qodoIteration)}`,
    verifiedEvidence: snapshot.evidence.filter(({ kind }) => kind === "direct").map(({ sourceUrl, observation }) => ({ sourceUrl, observation })),
    approvals: snapshot.approvals.map(({ action, actionDigest, status }) => ({ action, digest: actionDigest, status })),
    currentCommitSha: commitSha,
    context: { pullRequest, commitSha, iteration: snapshot.campaign.qodoIteration },
  };
}
