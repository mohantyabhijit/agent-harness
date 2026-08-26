import { z } from "zod";

import type { QodoFinding } from "../../domain/quality-gate.js";

const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const botIdentityPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
const severityLabel = /(?:^|\n)\s*(?:\*\*)?(?:severity|priority)\s*:\s*(?:\*\*)?\s*(high|medium|low|suggestion)\b/iu;
const severityLine = /^\s*(?:\*\*)?(?:severity|priority)\s*:\s*(?:\*\*)?\s*(?:high|medium|low|suggestion)\b[^\n]*$/iu;
const sourcePath = z.string().min(1).max(1_024).refine(isSafeSourcePath, "Invalid source path");
const body = z.string().min(1).max(20_000).refine((value) => value.trim().length > 0, "Empty comment body");
const disposition = z.string().min(1).max(2_000).refine((value) => value.trim().length > 0, "Empty disposition");

const authorSchema = z.object({ login: z.string().min(1).max(100) }).loose();
const commentIdentitySchema = z.object({ user: authorSchema }).loose();

const qodoCommentSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.url().max(2_048),
  body,
  path: sourcePath,
  line: z.number().int().positive(),
  user: z.object({ login: z.string().min(1).max(100) }).strict(),
  severity: z.enum(["high", "medium", "low", "suggestion"]).optional(),
  status: z.enum(["open", "fixed", "dismissed"]).default("open"),
  disposition: disposition.optional(),
}).strict().superRefine((comment, context) => {
  if (comment.status === "dismissed" && comment.disposition === undefined) {
    context.addIssue({ code: "custom", message: "Dismissed Qodo findings require a technical disposition" });
  }
});

export interface QodoCommentParserOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly allowlistedBotIdentities: readonly string[];
}

export function parseQodoReviewComments(
  input: unknown,
  options: QodoCommentParserOptions,
): readonly QodoFinding[] {
  if (!repositoryPattern.test(options.repository)) throw new TypeError("Invalid Qodo repository");
  if (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber < 1) {
    throw new TypeError("Invalid Qodo pull request number");
  }
  const allowedAuthors = normalizedAllowlist(options.allowlistedBotIdentities);
  const comments = z.array(z.unknown()).max(1_000).parse(input);
  const findings = new Map<string, QodoFinding>();

  for (const candidate of comments) {
    const identity = commentIdentitySchema.safeParse(candidate);
    if (!identity.success || !allowedAuthors.has(identity.data.user.login.toLocaleLowerCase("en-US"))) {
      continue;
    }
    const parsed = qodoCommentSchema.parse(candidate);
    assertSourceUrl(parsed.html_url, options.repository, options.pullRequestNumber, parsed.id);
    const finding = normalizeComment(parsed);
    const previous = findings.get(finding.id);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(finding)) {
      throw new Error("Conflicting Qodo comments share a GitHub comment identifier");
    }
    findings.set(finding.id, finding);
  }

  return [...findings.values()];
}

export function hasNonAllowlistedActionableComment(
  input: unknown,
  allowlistedBotIdentities: readonly string[],
): boolean {
  const allowedAuthors = normalizedAllowlist(allowlistedBotIdentities);
  const comments = z.array(z.unknown()).max(1_000).parse(input);
  for (const candidate of comments) {
    const identity = commentIdentitySchema.safeParse(candidate);
    if (!identity.success || allowedAuthors.has(identity.data.user.login.toLocaleLowerCase("en-US"))) continue;
    if (!isRecord(candidate)) continue;
    const structuredSeverity = typeof candidate.severity === "string" ? candidate.severity.toLocaleLowerCase("en-US") : undefined;
    const commentBody = typeof candidate.body === "string" ? candidate.body : "";
    const labeledSeverity = severityLabel.exec(commentBody)?.[1]?.toLocaleLowerCase("en-US");
    if (structuredSeverity === "high" || structuredSeverity === "medium" || labeledSeverity === "high" || labeledSeverity === "medium") return true;
  }
  return false;
}

function normalizeComment(comment: z.infer<typeof qodoCommentSchema>): QodoFinding {
  const explicitSeverity = comment.severity ?? severityLabel.exec(comment.body)?.[1]?.toLocaleLowerCase("en-US");
  const severity = isSeverity(explicitSeverity) ? explicitSeverity : "suggestion";
  return {
    id: `comment-${String(comment.id)}`,
    severity,
    status: comment.status,
    summary: conciseSummary(comment.body),
    sourceUrl: comment.html_url,
    body: comment.body,
    path: comment.path,
    line: comment.line,
    ...(comment.disposition === undefined ? {} : { disposition: comment.disposition }),
  };
}

function conciseSummary(value: string): string {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const summary = lines.find((line) => !severityLine.test(line)) ?? lines[0];
  if (summary === undefined) throw new Error("Qodo comment has no summary");
  return summary.length <= 280 ? summary : `${summary.slice(0, 279)}…`;
}

function normalizedAllowlist(identities: readonly string[]): ReadonlySet<string> {
  if (identities.length === 0 || identities.length > 20) throw new TypeError("Qodo bot allowlist is invalid");
  const normalized = new Set<string>();
  for (const identity of identities) {
    if (!botIdentityPattern.test(identity)) throw new TypeError("Qodo bot allowlist is invalid");
    normalized.add(identity.toLocaleLowerCase("en-US"));
  }
  return normalized;
}

function assertSourceUrl(url: string, repository: string, pullRequestNumber: number, commentId: number): void {
  const expected = `https://github.com/${repository}/pull/${String(pullRequestNumber)}#discussion_r${String(commentId)}`;
  if (url !== expected) throw new Error("Qodo source URL does not match the requested pull request comment");
}

function isSeverity(value: string | undefined): value is QodoFinding["severity"] {
  return value === "high" || value === "medium" || value === "low" || value === "suggestion";
}

function isSafeSourcePath(value: string): boolean {
  if (value !== value.trim() || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !containsControlCharacter(segment));
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
