import type { CampaignSnapshot, CampaignStore } from "../../application/ports/campaign-store.js";
import type { HarnessPort } from "../../application/ports/harness.js";
import type { QodoReviewPort } from "../../application/ports/qodo-review.js";
import type { QodoReviewBatch, SyncReview } from "../../application/sync-review.js";
import { HarnessUnavailable } from "../../application/ports/harness.js";
import { authenticatedReviewBatch } from "../../application/sync-authenticated-review.js";
import { createPersistenceLease, type RevocablePersistenceLease } from "../../application/ports/persistence-lease.js";

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
  readonly code?: "store_unavailable" | "campaign_retry_pending" | "unexpected_failure" | "shutdown_timeout" | "provider_unavailable" | "repair_verifier_unavailable" | "health_stale" | "scheduler_stopped";
}

export interface QodoReviewJobDependencies {
  readonly store: CampaignStore;
  readonly review?: QodoReviewPort;
  readonly source?: QodoReviewSource;
  readonly syncReview: Pick<SyncReview, "execute"> & Partial<Pick<SyncReview, "enforceIterationLimit">>;
  readonly scheduler: ReviewJobScheduler;
  readonly intervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly providerReady?: boolean;
  readonly reviewAuthorityReady?: () => boolean;
  readonly repairVerifierReady?: () => boolean;
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
  let activeLease: RevocablePersistenceLease | undefined;
  let generation = 0;
  let lastStoreHealthAt: number | undefined;
  let stopped = false;
  let health: QodoReviewJobHealth = dependencies.providerReady === false ? { status: "degraded", code: "provider_unavailable" } : { status: "ready" };
  const runTick = async (signal: AbortSignal, runGeneration: number, lease: RevocablePersistenceLease): Promise<void> => {
    let snapshots: readonly CampaignSnapshot[];
    try {
      snapshots = await dependencies.store.listByStatus("qodo_review");
      lastStoreHealthAt = Date.now();
    } catch {
      if (runGeneration === generation) health = { status: "degraded", code: "store_unavailable" };
      return;
    }
    if (dependencies.providerReady === false || dependencies.reviewAuthorityReady?.() === false) {
      if (runGeneration === generation) health = { status: "degraded", code: "provider_unavailable" };
      return;
    }
    if (dependencies.repairVerifierReady?.() === false) {
      if (runGeneration === generation) health = { status: "degraded", code: "repair_verifier_unavailable" };
      return;
    }
    let retryPending = false;
    for (const snapshot of snapshots) {
      if (signal.aborted) return;
      try {
        if (snapshot.campaign.qodoIteration === 3 && dependencies.syncReview.enforceIterationLimit !== undefined) {
          lease.assertCurrent();
          await dependencies.syncReview.enforceIterationLimit(snapshot.campaign.id, { signal, timeoutMs: dependencies.shutdownTimeoutMs, persistenceLease: lease });
          continue;
        }
        const batch = dependencies.review === undefined
          ? await dependencies.source?.fetch(snapshot, { signal, timeoutMs: dependencies.shutdownTimeoutMs })
          : await authenticatedReviewBatch(dependencies.review, snapshot, { signal, timeoutMs: dependencies.shutdownTimeoutMs });
        if (isAborted(signal)) return;
        lease.assertCurrent();
        if (batch !== undefined) await dependencies.syncReview.execute(snapshot.campaign.id, batch, { signal, timeoutMs: dependencies.shutdownTimeoutMs, persistenceLease: lease });
      } catch {
        retryPending = true;
        // A later tick retries from durable campaign state. The job never
        // logs provider output because it may contain credential material.
      }
    }
    if (runGeneration === generation) health = retryPending ? { status: "degraded", code: "campaign_retry_pending" } : { status: "ready" };
  };
  const tick = async (): Promise<void> => {
    if (activeTick !== undefined) return activeTick;
    const runGeneration = ++generation;
    activeController = new AbortController();
    const lease = createPersistenceLease(`qodo-review-generation-${String(runGeneration)}`);
    activeLease = lease;
    health = { status: "running" };
    const thisTick = runTick(activeController.signal, runGeneration, lease).catch(() => {
      if (runGeneration === generation) health = { status: "degraded", code: "unexpected_failure" };
    });
    activeTick = thisTick;
    try {
      await thisTick;
    } finally {
      if (activeTick === thisTick) {
        activeTick = undefined;
        activeController = undefined;
        if (activeLease === lease) activeLease = undefined;
      }
    }
  };
  return {
    start() {
      if (started) return;
      stopped = false;
      started = true;
      timer = dependencies.scheduler.setInterval(() => { void tick().catch(() => { health = { status: "degraded", code: "unexpected_failure" }; }); }, dependencies.intervalMs);
      void tick().catch(() => { health = { status: "degraded", code: "unexpected_failure" }; });
    },
    async stop() {
      if (started) {
        dependencies.scheduler.clearInterval(timer);
        started = false;
        timer = undefined;
      }
      activeController?.abort();
      if (activeTick !== undefined) {
        const stoppingTick = activeTick;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let outcome: "completed" | "timeout";
        try {
          outcome = await Promise.race([
            stoppingTick.then(() => "completed" as const),
            new Promise<"timeout">((resolve) => { deadline = setTimeout(() => { resolve("timeout"); }, dependencies.shutdownTimeoutMs); }),
          ]);
        } finally {
          if (deadline !== undefined) clearTimeout(deadline);
        }
        if (outcome === "timeout") {
          activeLease?.revoke();
          activeLease = undefined;
          generation += 1;
          activeTick = undefined;
          activeController = undefined;
          health = { status: "degraded", code: "shutdown_timeout" };
          void stoppingTick.catch(() => undefined);
        }
      }
      stopped = true;
    },
    tick,
    health: () => {
      if (dependencies.reviewAuthorityReady !== undefined || dependencies.repairVerifierReady !== undefined) {
        if (stopped) return { status: "degraded", code: "scheduler_stopped" };
        if (lastStoreHealthAt === undefined || Date.now() - lastStoreHealthAt > dependencies.intervalMs * 2 + dependencies.shutdownTimeoutMs) return { status: "degraded", code: "health_stale" };
        if (dependencies.reviewAuthorityReady?.() === false) return { status: "degraded", code: "provider_unavailable" };
        if (dependencies.repairVerifierReady?.() === false) return { status: "degraded", code: "repair_verifier_unavailable" };
      }
      return { ...health };
    },
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
