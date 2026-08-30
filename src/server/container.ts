import { randomUUID } from "node:crypto";

import { TrueForge } from "@truefoundry/trueforge-sdk";
import Database from "better-sqlite3";

import { SqliteCampaignStore } from "../adapters/sqlite/campaign-store.js";
import { TrueForgeGithubCatalog } from "../adapters/trueforge/github-catalog.js";
import { TrueForgeHarness } from "../adapters/trueforge/harness.js";
import { TrueForgeQodoReview, UnavailableQodoReviewAuthority } from "../adapters/qodo/trueforge-qodo-review.js";
import { SyncReview } from "../application/sync-review.js";
import type { AppDependencies } from "./app.js";
import type { ServerConfig } from "./config.js";
import { createQodoReviewJob, type QodoReviewJob, type ReviewJobScheduler } from "./jobs/qodo-review-job.js";
import { bearerAuthorizationPolicy } from "./authorization.js";

export interface ServerContainer {
  readonly dependencies: AppDependencies;
  readonly reviewJob: QodoReviewJob;
  close(): Promise<void>;
}

export function createContainer(config: ServerConfig): ServerContainer {
  const database = new Database(config.DATABASE_PATH);
  const store = new SqliteCampaignStore(database);
  const client = new TrueForge({ baseUrl: config.TRUEFORGE_BASE_URL });
  const harness = new TrueForgeHarness(client);
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: () => randomUUID() };
  const scheduler: ReviewJobScheduler = {
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle) => { clearInterval(handle as NodeJS.Timeout); },
  };
  const qodoReview = new TrueForgeQodoReview(harness, new UnavailableQodoReviewAuthority(), { allowlistedBotIdentities: config.QODO_BOT_IDENTITIES });
  const reviewJob: QodoReviewJob = createQodoReviewJob({
    store,
    review: qodoReview,
    syncReview: new SyncReview(store, harness, clock, ids),
    scheduler,
    intervalMs: config.QODO_POLL_INTERVAL_MS,
    shutdownTimeoutMs: config.QODO_SHUTDOWN_TIMEOUT_MS,
    reviewAuthorityReady: () => qodoReview.isReady(),
    repairVerifierReady: () => false,
  });
  const dependencies: AppDependencies = {
    store,
    harness,
    catalog: new TrueForgeGithubCatalog(harness),
    clock,
    ids,
    authorization: bearerAuthorizationPolicy({ operator: config.OPERATOR_BEARER_TOKEN, reviewProvider: config.REVIEW_PROVIDER_BEARER_TOKEN }),
    reviewHealth: () => reviewJob.health(),
    qodoReview,
    requireReviewHealth: true,
    reviewSyncTimeoutMs: config.QODO_SHUTDOWN_TIMEOUT_MS,
  };
  return {
    dependencies,
    reviewJob,
    async close() {
      await reviewJob.stop();
      if (database.open) database.close();
    },
  };
}
