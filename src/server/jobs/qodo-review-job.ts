import type { CampaignSnapshot, CampaignStore } from "../../application/ports/campaign-store.js";
import type { HarnessPort } from "../../application/ports/harness.js";
import type { QodoReviewBatch, SyncReview } from "../../application/sync-review.js";
import { parseQodoReviewBatch } from "../../application/qodo-review-batch.js";

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
}

export interface QodoReviewJobDependencies {
  readonly store: CampaignStore;
  readonly source: QodoReviewSource;
  readonly syncReview: Pick<SyncReview, "execute">;
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
  let timer: unknown;
  let started = false;
  let activeTick: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  const runTick = async (signal: AbortSignal): Promise<void> => {
    const snapshots = await dependencies.store.listByStatus("qodo_review");
    for (const snapshot of snapshots) {
      if (signal.aborted) return;
      if (snapshot.campaign.qodoIteration > 3) continue;
      try {
        const batch = await dependencies.source.fetch(snapshot, { signal, timeoutMs: dependencies.shutdownTimeoutMs });
        if (isAborted(signal)) return;
        if (batch !== undefined) await dependencies.syncReview.execute(snapshot.campaign.id, batch);
      } catch {
        // A later tick retries from durable campaign state. The job never
        // logs provider output because it may contain credential material.
      }
    }
  };
  const tick = async (): Promise<void> => {
    if (activeTick !== undefined) return activeTick;
    activeController = new AbortController();
    activeTick = runTick(activeController.signal);
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
      timer = dependencies.scheduler.setInterval(() => { void tick(); }, dependencies.intervalMs);
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
  };
}

function isAborted(signal: AbortSignal): boolean { return signal.aborted; }

export class HarnessQodoReviewSource implements QodoReviewSource {
  constructor(private readonly harness: HarnessPort) {}

  async fetch(snapshot: CampaignSnapshot, options: { signal: AbortSignal; timeoutMs: number }): Promise<QodoReviewBatch | undefined> {
    const pullRequest = singletonReference(snapshot, "pull_request");
    const commitSha = singletonReference(snapshot, "commit");
    const result = await this.harness.runChildSession({
      campaignId: snapshot.campaign.id,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      goal: `Synchronize Qodo review iteration ${String(snapshot.campaign.qodoIteration)}`,
      verifiedEvidence: snapshot.evidence.filter(({ kind }) => kind === "direct").map(({ sourceUrl, observation }) => ({ sourceUrl, observation })),
      approvals: snapshot.approvals.map(({ action, actionDigest, status }) => ({ action, digest: actionDigest, status })),
      currentCommitSha: commitSha,
      context: { pullRequest, commitSha, iteration: snapshot.campaign.qodoIteration },
    }, "sync_qodo", options);
    return parseQodoReviewBatch(result.output);
  }
}

function singletonReference(snapshot: CampaignSnapshot, kind: "pull_request" | "commit"): string {
  const references = snapshot.externalReferences.filter((reference) => reference.kind === kind);
  if (references.length !== 1 || references[0] === undefined) throw new Error(`Campaign ${kind} identity is unavailable`);
  return references[0].value;
}
