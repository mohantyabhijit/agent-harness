import { z } from "zod";
import type { QodoFinding } from "../domain/quality-gate.js";

const boundedText = z.string().trim().min(1).max(2_000);
const findingSchema = z.object({
  id: z.string().trim().min(1).max(128),
  severity: z.enum(["high", "medium", "low", "suggestion"]),
  status: z.enum(["open", "fixed", "dismissed"]),
  summary: boundedText,
  sourceUrl: z.url().max(2_048).refine(isGitHubReviewSource, "Invalid Qodo source URL").optional(),
  body: z.string().min(1).max(20_000).refine((value) => value.trim().length > 0).optional(),
  path: z.string().min(1).max(1_024).refine(isSafeSourcePath).optional(),
  line: z.number().int().positive().optional(),
  disposition: boundedText.optional(),
}).strict().superRefine((finding, context) => {
  const sourceFieldCount = [finding.body, finding.path, finding.line].filter((value) => value !== undefined).length;
  if (sourceFieldCount !== 0 && sourceFieldCount !== 3) context.addIssue({ code: "custom", message: "Qodo source fields must be complete" });
  if (finding.status === "dismissed" && finding.disposition === undefined) context.addIssue({ code: "custom", message: "Dismissed Qodo finding requires disposition" });
});

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
    ...(finding.body === undefined ? {} : { body: finding.body }),
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
  })) };
}

export function parseQodoFinding(input: unknown): QodoFinding {
  const finding = findingSchema.parse(input);
  return {
    id: finding.id,
    severity: finding.severity,
    status: finding.status,
    summary: finding.summary,
    ...(finding.sourceUrl === undefined ? {} : { sourceUrl: finding.sourceUrl }),
    ...(finding.body === undefined ? {} : { body: finding.body }),
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
  };
}

function isSafeSourcePath(value: string): boolean {
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !containsControlCharacter(segment));
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

function isGitHubReviewSource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "" && url.search === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname) && /^#discussion_r[1-9][0-9]*$/u.test(url.hash);
  } catch {
    return false;
  }
}
