import { z } from "zod";
import type { QodoFinding } from "../domain/quality-gate.js";

const boundedText = z.string().trim().min(1).max(2_000);
const findingSchema = z.object({
  id: z.string().trim().min(1).max(128),
  severity: z.enum(["high", "medium", "low", "suggestion"]),
  status: z.enum(["open", "fixed", "dismissed"]),
  summary: boundedText,
  sourceUrl: z.url().max(2_048).optional(),
  disposition: boundedText.optional(),
}).strict();

export const qodoReviewBatchSchema = z.object({
  campaignId: z.string().trim().min(1).max(128),
  pullRequest: z.string().max(2_048).regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u),
  reviewId: z.string().trim().min(1).max(128),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  testsPassed: z.boolean(),
  complete: z.boolean(),
  findings: z.array(findingSchema).max(1_000),
}).strict().superRefine((value, context) => {
  if (!value.complete && value.findings.length === 0) context.addIssue({ code: "custom", message: "Incomplete review requires findings" });
  if (new Set(value.findings.map(({ id }) => id)).size !== value.findings.length) context.addIssue({ code: "custom", message: "Finding identifiers must be unique" });
});

export interface QodoReviewBatch {
  readonly campaignId: string;
  readonly pullRequest: string;
  readonly reviewId: string;
  readonly commitSha: string;
  readonly testsPassed: boolean;
  readonly complete: boolean;
  readonly findings: readonly QodoFinding[];
}

export function parseQodoReviewBatch(input: unknown): QodoReviewBatch {
  const parsed = qodoReviewBatchSchema.parse(input);
  return { ...parsed, findings: parsed.findings.map((finding) => ({
    id: finding.id, severity: finding.severity, status: finding.status, summary: finding.summary,
    ...(finding.sourceUrl === undefined ? {} : { sourceUrl: finding.sourceUrl }),
    ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
  })) };
}
