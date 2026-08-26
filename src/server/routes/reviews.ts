import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { QodoReviewBatch, SyncReview } from "../../application/sync-review.js";
import { campaignIdSchema } from "./support.js";

const paramsSchema = z.object({ id: campaignIdSchema }).strict();
const findingSchema = z.object({
  id: z.string().trim().min(1).max(128),
  severity: z.enum(["high", "medium", "low", "suggestion"]),
  status: z.enum(["open", "fixed", "dismissed"]),
  summary: z.string().trim().min(1).max(2_000),
  sourceUrl: z.url().max(2_048).optional(),
  disposition: z.string().trim().min(1).max(2_000).optional(),
}).strict();
const reviewSchema = z.object({
  campaignId: campaignIdSchema,
  pullRequest: z.url().max(2_048),
  reviewId: z.string().trim().min(1).max(128),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  testsPassed: z.boolean(),
  complete: z.boolean(),
  findings: z.array(findingSchema).max(1_000),
}).strict().superRefine((value, context) => {
  if (!value.complete && value.findings.length === 0) {
    context.addIssue({ code: "custom", message: "Incomplete review must include findings" });
  }
  if (new Set(value.findings.map(({ id }) => id)).size !== value.findings.length) {
    context.addIssue({ code: "custom", message: "Finding identifiers must be unique" });
  }
});

export interface ReviewRouteDependencies {
  readonly syncReview: SyncReview;
}

export function registerReviewRoutes(app: FastifyInstance, dependencies: ReviewRouteDependencies): void {
  app.post("/api/campaigns/:id/reviews/sync", async (request) => {
    const { id } = paramsSchema.parse(request.params);
    const batch = reviewSchema.parse(request.body) as QodoReviewBatch;
    return dependencies.syncReview.execute(id, batch);
  });
}
