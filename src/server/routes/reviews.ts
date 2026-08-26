import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseQodoReviewBatch } from "../../application/qodo-review-batch.js";
import type { SyncReview } from "../../application/sync-review.js";
import { campaignIdSchema } from "./support.js";

const paramsSchema = z.object({ id: campaignIdSchema }).strict();

export interface ReviewRouteDependencies {
  readonly syncReview: SyncReview;
}

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.post("/api/campaigns/:id/reviews/sync", { config: { capability: "review_provider" } }, async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const batch = parseQodoReviewBatch(request.body);
    return dependencies.syncReview.execute(id, batch);
  });
}
