import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SyncAuthenticatedReview } from "../../application/sync-authenticated-review.js";
import { campaignIdSchema } from "./support.js";
import { createPersistenceLease } from "../../application/ports/persistence-lease.js";
import { HarnessUnavailable } from "../../application/ports/harness.js";

const paramsSchema = z.object({ id: campaignIdSchema }).strict();

export interface ReviewRouteDependencies {
  readonly syncReview: SyncAuthenticatedReview;
  readonly timeoutMs?: number;
}

const locatorSchema = z.object({
  schemaVersion: z.literal("qodo_review_locator_v1"),
  reviewUrl: z.url().max(2_048),
  sourceReceipt: z.string().min(16).max(512).refine((value) => value === value.trim()),
}).strict();

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.post("/api/campaigns/:id/reviews/sync", { config: { capability: "review_provider" } }, async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const timeoutMs = dependencies.timeoutMs ?? 5_000;
    const controller = new AbortController();
    const lease = createPersistenceLease(`http-review-${id}-${String(Date.now())}`);
    let rejectCancellation!: (reason: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const revoke = () => { controller.abort(); lease.revoke(); rejectCancellation(new HarnessUnavailable()); };
    const deadline = setTimeout(revoke, timeoutMs);
    request.raw.once("aborted", revoke);
    const execution = dependencies.syncReview.execute(id, locatorSchema.parse(request.body), { signal: controller.signal, timeoutMs, persistenceLease: lease });
    try {
      return await Promise.race([execution, cancelled]);
    } finally {
      clearTimeout(deadline);
      request.raw.off("aborted", revoke);
      lease.revoke();
      void execution.catch(() => undefined);
    }
  });
}
