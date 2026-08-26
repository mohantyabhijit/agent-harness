import { z } from "zod";

import type { CampaignPacket, HarnessPort } from "../../application/ports/harness.js";
import { HarnessError, HarnessOutputInvalid } from "../../application/ports/harness.js";
import { HarnessUnavailable } from "../../application/ports/harness.js";
import type { QodoReview, QodoReviewAuthorityPort, QodoReviewCandidate, QodoReviewLocator, QodoReviewPort, QodoReviewRequest } from "../../application/ports/qodo-review.js";
import { hasNonAllowlistedActionableComment, parseQodoReviewComments } from "./github-review-parser.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedText = z.string().min(1).max(2_000).refine((value) => value === value.trim());
const exactOpaqueText = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum).refine((value) => value === value.trim());
const packetSchema = z.object({
  campaignId: z.string().trim().min(1).max(128),
  repository: repositorySchema,
  issueNumber: z.number().int().positive(),
  verifiedEvidence: z.array(z.object({ sourceUrl: z.url().max(2_048), observation: boundedText }).strict()).max(1_000),
  approvals: z.array(z.object({ action: boundedText, digest: boundedText, status: boundedText }).strict()).max(1_000),
  currentCommitSha: commitSchema,
}).loose();
const reviewEnvelopeSchema = z.object({
  schemaVersion: z.literal("qodo_github_review_v1"),
  repository: repositorySchema,
  pullRequestNumber: z.number().int().positive(),
  reviewId: exactOpaqueText(1, 128),
  reviewUrl: z.url().max(2_048),
  sourceIdentity: exactOpaqueText(1, 100),
  sourceReceipt: exactOpaqueText(16, 512),
  commitSha: commitSchema,
  testsPassed: z.boolean(),
  complete: z.boolean(),
  comments: z.array(z.unknown()).max(1_000),
}).strict();
const reviewLocatorSchema = z.object({
  schemaVersion: z.literal("qodo_review_locator_v1"),
  reviewUrl: z.url().max(2_048),
  sourceReceipt: exactOpaqueText(16, 512),
}).strict();

export interface TrueForgeQodoReviewConfig {
  readonly allowlistedBotIdentities: readonly string[];
}

/** Production-safe placeholder until an authenticated GitHub review adapter is injected. */
export class UnavailableQodoReviewAuthority implements QodoReviewAuthorityPort {
  isAvailable(): boolean { return false; }
  async resolve(): Promise<never> {
    throw new HarnessUnavailable();
  }
}

export class TrueForgeQodoReview implements QodoReviewPort {
  readonly #allowedAuthors: readonly string[];

  constructor(
    private readonly harness: HarnessPort,
    private readonly authority: QodoReviewAuthorityPort,
    config: TrueForgeQodoReviewConfig,
  ) {
    this.#allowedAuthors = validatedAuthors(config.allowlistedBotIdentities);
  }

  isReady(): boolean { return this.authority.isAvailable(); }

  async getReview(
    repository: string,
    pullRequestNumber: number,
    request: QodoReviewRequest,
  ): Promise<QodoReview> {
    try {
      const parsedPacket = packetSchema.parse(request.packet);
      if (parsedPacket.repository !== repository || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
        throw new HarnessOutputInvalid();
      }
      const pullRequest = `https://github.com/${repository}/pull/${String(pullRequestNumber)}`;
      const responseSchema = qodoReviewLocatorV1Schema(repository, pullRequestNumber);
      const packet: CampaignPacket = {
        campaignId: parsedPacket.campaignId,
        repository,
        issueNumber: parsedPacket.issueNumber,
        goal: `Locate the GitHub-hosted Qodo review for ${pullRequest}. Return only qodo_review_locator_v1 with the canonical review URL and opaque provider receipt. Do not assert identity, completion, tests, findings, comments, commit state, or dispositions. Do not perform GitHub writes.`,
        verifiedEvidence: parsedPacket.verifiedEvidence,
        approvals: parsedPacket.approvals,
        currentCommitSha: parsedPacket.currentCommitSha,
        context: {
          pullRequest,
          pullRequestNumber,
          commitSha: parsedPacket.currentCommitSha,
          allowedAuthors: this.#allowedAuthors,
          responseContract: "qodo_review_locator_v1",
          responseSchema,
        },
      };
      const result = request.locator === undefined
        ? await this.harness.runChildSession(packet, "sync_qodo", requestOptions(request))
        : { sessionId: "authenticated-provider-ingress", output: request.locator };
      if (result.sessionId.trim().length === 0 || result.sessionId.length > 1_024) throw new HarnessOutputInvalid();
      const locator = validatedLocator(result.output, repository, pullRequestNumber);
      const review = validatedEnvelope(
        await this.authority.resolve(locator, {
          repository,
          pullRequestNumber,
          commitSha: parsedPacket.currentCommitSha,
          allowlistedBotIdentities: this.#allowedAuthors,
        }, requestOptions(request) ?? {}),
        repository,
        pullRequestNumber,
        parsedPacket.currentCommitSha,
        this.#allowedAuthors,
      );
      if (review.reviewUrl !== locator.reviewUrl || review.sourceReceipt !== locator.sourceReceipt) {
        throw new HarnessOutputInvalid();
      }
      const findings = parseQodoReviewComments(review.comments, {
        repository,
        pullRequestNumber,
        allowlistedBotIdentities: this.#allowedAuthors,
      });
      return {
        syncSessionId: result.sessionId,
        reviewId: review.reviewId,
        reviewUrl: review.reviewUrl,
        sourceIdentity: review.sourceIdentity,
        sourceReceipt: review.sourceReceipt,
        commitSha: review.commitSha,
        testsPassed: review.testsPassed,
        complete: review.complete && !hasNonAllowlistedActionableComment(review.comments, this.#allowedAuthors),
        findings,
      };
    } catch (error) {
      if (isHarnessError(error)) throw error;
      throw new HarnessOutputInvalid();
    }
  }
}

function validatedLocator(value: unknown, repository: string, pullRequestNumber: number): QodoReviewLocator {
  const locator = reviewLocatorSchema.parse(value);
  if (!isCanonicalReviewUrl(locator.reviewUrl, repository, pullRequestNumber)) throw new HarnessOutputInvalid();
  return locator;
}

function validatedEnvelope(
  value: unknown,
  repository: string,
  pullRequestNumber: number,
  commitSha: string,
  allowedAuthors: readonly string[],
): QodoReviewCandidate {
  const review = reviewEnvelopeSchema.parse(value);
  if (review.repository !== repository || review.pullRequestNumber !== pullRequestNumber || review.commitSha !== commitSha ||
    !isCanonicalReviewUrl(review.reviewUrl, repository, pullRequestNumber) || !allowedAuthors.includes(review.sourceIdentity.toLocaleLowerCase("en-US"))) {
    throw new HarnessOutputInvalid();
  }
  return review;
}

function isCanonicalReviewUrl(value: string, repository: string, pullRequestNumber: number): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" &&
      url.port === "" && url.search === "" && url.pathname === `/${repository}/pull/${String(pullRequestNumber)}` &&
      /^#pullrequestreview-[1-9][0-9]*$/u.test(url.hash);
  } catch {
    return false;
  }
}

function qodoReviewLocatorV1Schema(
  repository: string,
  pullRequestNumber: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    additionalProperties: false,
    required: ["schemaVersion", "reviewUrl", "sourceReceipt"],
    fields: {
      schemaVersion: { const: "qodo_review_locator_v1" },
      reviewUrl: { constPrefix: `https://github.com/${repository}/pull/${String(pullRequestNumber)}#pullrequestreview-`, semantics: "locator only; authority resolves all review facts" },
      sourceReceipt: { type: "opaque authenticated provider receipt", minLength: 16, semantics: "locator only; authority independently validates and resolves it" },
    },
  });
}

function validatedAuthors(authors: readonly string[]): readonly string[] {
  if (authors.length === 0 || authors.length > 20) throw new TypeError("Qodo bot allowlist is invalid");
  const normalized = authors.map((author) => author.toLocaleLowerCase("en-US"));
  parseQodoReviewComments([], {
    repository: "owner/repo",
    pullRequestNumber: 1,
    allowlistedBotIdentities: normalized,
  });
  return Object.freeze([...new Set(normalized)]);
}

function requestOptions(request: QodoReviewRequest): { signal?: AbortSignal; timeoutMs?: number } | undefined {
  if (request.signal === undefined && request.timeoutMs === undefined) return undefined;
  return {
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  };
}

function isHarnessError(error: unknown): boolean {
  return error instanceof HarnessError;
}
