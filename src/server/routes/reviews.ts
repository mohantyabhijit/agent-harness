import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SyncAuthenticatedReview } from "../../application/sync-authenticated-review.js";
import { campaignIdSchema } from "./support.js";

const paramsSchema = z.object({ id: campaignIdSchema }).strict();

export interface ReviewRouteDependencies {
  readonly syncReview: SyncAuthenticatedReview;
}

const locatorSchema = z.object({
  schemaVersion: z.literal("qodo_review_locator_v1"),
  reviewUrl: z.url().max(2_048),
  sourceReceipt: z.string().min(16).max(512).refine((value) => value === value.trim()),
}).strict();

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.post("/api/campaigns/:id/reviews/sync", { config: { capability: "review_provider" } }, async (request) => {
    const { id } = paramsSchema.parse(request.params);
    return dependencies.syncReview.execute(id, locatorSchema.parse(request.body));
  });
}
