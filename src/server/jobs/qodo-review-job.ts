import type { CampaignSnapshot, CampaignStore } from "../../application/ports/campaign-store.js";
import type { CampaignPacket } from "../../application/ports/harness.js";
import type { HarnessPort } from "../../application/ports/harness.js";
import type { QodoReviewPort } from "../../application/ports/qodo-review.js";
import type { QodoReviewBatch, SyncReview } from "../../application/sync-review.js";
import { isPullRequest } from "../../application/external-action.js";
import { HarnessUnavailable } from "../../application/ports/harness.js";

/** Compatibility seam for injected legacy sources; production uses QodoReviewPort. */
export interface QodoReviewSource {
  fetch(snapshot: CampaignSnapshot, options: { signal: AbortSignal; timeoutMs: number }): Promise<QodoReviewBatch | undefined>;
}

export interface ReviewJobScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface QodoReviewJob {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
  health(): QodoReviewJobHealth;
}

export interface QodoReviewJobHealth {
  readonly status: "ready" | "running" | "degraded";
  readonly code?: "store_unavailable" | "campaign_retry_pending" | "unexpected_failure";
}

export interface QodoReviewJobDependencies {
  readonly store: CampaignStore;
  readonly review?: QodoReviewPort;
  readonly source?: QodoReviewSource;
  readonly syncReview: Pick<SyncReview, "execute"> & Partial<Pick<SyncReview, "enforceIterationLimit">>;
  readonly scheduler: ReviewJobScheduler;
  readonly intervalMs: number;
  readonly shutdownTimeoutMs: number;
}

export function createQodoReviewJob(dependencies: QodoReviewJobDependencies): QodoReviewJob {
  if (!Number.isSafeInteger(dependencies.intervalMs) || dependencies.intervalMs < 10_000) {
    throw new TypeError("Qodo review interval must be at least 10000 milliseconds");
  }
  if (!Number.isSafeInteger(dependencies.shutdownTimeoutMs) || dependencies.shutdownTimeoutMs < 10 || dependencies.shutdownTimeoutMs > 30_000) {
    throw new TypeError("Qodo shutdown timeout must be between 10 and 30000 milliseconds");
  }
  if ((dependencies.review === undefined) === (dependencies.source === undefined)) {
    throw new TypeError("Qodo review job requires exactly one review provider");
  }
  let timer: unknown;
  let started = false;
  let activeTick: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let health: QodoReviewJobHealth = { status: "ready" };
  const runTick = async (signal: AbortSignal): Promise<void> => {
    let snapshots: readonly CampaignSnapshot[];
    try {
      snapshots = await dependencies.store.listByStatus("qodo_review");
    } catch {
      health = { status: "degraded", code: "store_unavailable" };
      return;
    }
    let retryPending = false;
    for (const snapshot of snapshots) {
      if (signal.aborted) return;
      try {
        if (snapshot.campaign.qodoIteration === 3 && dependencies.syncReview.enforceIterationLimit !== undefined) {
          await dependencies.syncReview.enforceIterationLimit(snapshot.campaign.id);
          continue;
        }
        const batch = dependencies.review === undefined
          ? await dependencies.source?.fetch(snapshot, { signal, timeoutMs: dependencies.shutdownTimeoutMs })
          : await reviewBatchFromPort(dependencies.review, snapshot, signal, dependencies.shutdownTimeoutMs);
        if (isAborted(signal)) return;
        if (batch !== undefined) await dependencies.syncReview.execute(snapshot.campaign.id, batch, { signal, timeoutMs: dependencies.shutdownTimeoutMs });
      } catch {
        retryPending = true;
        // A later tick retries from durable campaign state. The job never
        // logs provider output because it may contain credential material.
      }
    }
    health = retryPending ? { status: "degraded", code: "campaign_retry_pending" } : { status: "ready" };
  };
  const tick = async (): Promise<void> => {
    if (activeTick !== undefined) return activeTick;
    activeController = new AbortController();
    health = { status: "running" };
    activeTick = runTick(activeController.signal).catch(() => { health = { status: "degraded", code: "unexpected_failure" }; });
    try {
      await activeTick;
    } finally {
      activeTick = undefined;
      activeController = undefined;
    }
  };
  return {
    start() {
      if (started) return;
      started = true;
      timer = dependencies.scheduler.setInterval(() => { void tick().catch(() => { health = { status: "degraded", code: "unexpected_failure" }; }); }, dependencies.intervalMs);
    },
    async stop() {
      if (started) {
        dependencies.scheduler.clearInterval(timer);
        started = false;
        timer = undefined;
      }
      activeController?.abort();
      if (activeTick !== undefined) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([activeTick, new Promise<void>((resolve) => { deadline = setTimeout(resolve, dependencies.shutdownTimeoutMs); })]);
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
        }
      }
    },
    tick,
    health: () => ({ ...health }),
  };
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted; }

export class HarnessQodoReviewSource implements QodoReviewSource {
  constructor(private readonly harness: HarnessPort) {}

  async fetch(snapshot: CampaignSnapshot, options: { signal: AbortSignal; timeoutMs: number }): Promise<QodoReviewBatch | undefined> {
    void snapshot;
    void options;
    void this.harness;
    throw new HarnessUnavailable();
  }
}

function singletonReference(snapshot: CampaignSnapshot, kind: "pull_request" | "commit"): string {
  const references = snapshot.externalReferences.filter((reference) => reference.kind === kind);
  if (references.length !== 1 || references[0] === undefined) throw new Error(`Campaign ${kind} identity is unavailable`);
  return references[0].value;
}

function parsePullRequestNumber(pullRequest: string, repository: string): number {
  if (!isPullRequest(pullRequest, repository)) throw new Error("Campaign pull request identity is invalid");
  const segment = pullRequest.slice(pullRequest.lastIndexOf("/") + 1);
  const pullRequestNumber = Number(segment);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) throw new Error("Campaign pull request identity is invalid");
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

async function reviewBatchFromPort(
  reviewPort: QodoReviewPort,
  snapshot: CampaignSnapshot,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<QodoReviewBatch> {
  const pullRequest = singletonReference(snapshot, "pull_request");
  const commitSha = singletonReference(snapshot, "commit");
  const review = await reviewPort.getReview(
    snapshot.campaign.repository,
    parsePullRequestNumber(pullRequest, snapshot.campaign.repository),
    { packet: reviewPacket(snapshot, pullRequest, commitSha), signal, timeoutMs },
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
