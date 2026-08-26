import { z } from "zod";

import type { CampaignPacket, HarnessPort } from "../../application/ports/harness.js";
import { HarnessError, HarnessOutputInvalid } from "../../application/ports/harness.js";
import { HarnessUnavailable } from "../../application/ports/harness.js";
import type { QodoReview, QodoReviewAuthorityPort, QodoReviewCandidate, QodoReviewPort, QodoReviewRequest } from "../../application/ports/qodo-review.js";
import { hasNonAllowlistedActionableComment, parseQodoReviewComments } from "./github-review-parser.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedText = z.string().trim().min(1).max(2_000);
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
  reviewId: z.string().trim().min(1).max(128),
  reviewUrl: z.url().max(2_048),
  sourceIdentity: z.string().trim().min(1).max(100),
  sourceReceipt: z.string().trim().min(16).max(512),
  commitSha: commitSchema,
  testsPassed: z.boolean(),
  complete: z.boolean(),
  comments: z.array(z.unknown()).max(1_000),
}).strict();

export interface TrueForgeQodoReviewConfig {
  readonly allowlistedBotIdentities: readonly string[];
}

/** Production-safe placeholder until an authenticated GitHub review adapter is injected. */
export class UnavailableQodoReviewAuthority implements QodoReviewAuthorityPort {
  async authenticate(): Promise<never> {
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
      const responseSchema = qodoGithubReviewV1Schema(repository, pullRequestNumber, parsedPacket.currentCommitSha, this.#allowedAuthors);
      const packet: CampaignPacket = {
        campaignId: parsedPacket.campaignId,
        repository,
        issueNumber: parsedPacket.issueNumber,
        goal: `Locate the GitHub-hosted Qodo review for ${pullRequest}. Return exactly qodo_github_review_v1. The source receipt is verified independently; never invent review identity, completion, test, comment, or disposition fields. Do not perform GitHub writes.`,
        verifiedEvidence: parsedPacket.verifiedEvidence,
        approvals: parsedPacket.approvals,
        currentCommitSha: parsedPacket.currentCommitSha,
        context: {
          pullRequest,
          pullRequestNumber,
          commitSha: parsedPacket.currentCommitSha,
          allowedAuthors: this.#allowedAuthors,
          responseContract: "qodo_github_review_v1",
          responseSchema,
        },
      };
      const result = await this.harness.runChildSession(
        packet,
        "sync_qodo",
        requestOptions(request),
      );
      if (result.sessionId.trim().length === 0 || result.sessionId.length > 512) throw new HarnessOutputInvalid();
      const candidate = validatedEnvelope(result.output, repository, pullRequestNumber, parsedPacket.currentCommitSha, this.#allowedAuthors);
      const review = validatedEnvelope(
        await this.authority.authenticate(candidate, requestOptions(request) ?? {}),
        repository,
        pullRequestNumber,
        parsedPacket.currentCommitSha,
        this.#allowedAuthors,
      );
      if (
        review.reviewId !== candidate.reviewId || review.reviewUrl !== candidate.reviewUrl ||
        review.sourceIdentity !== candidate.sourceIdentity || review.sourceReceipt !== candidate.sourceReceipt
      ) {
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

function validatedEnvelope(
  value: unknown,
  repository: string,
  pullRequestNumber: number,
  commitSha: string,
  allowedAuthors: readonly string[],
): QodoReviewCandidate {
  const review = reviewEnvelopeSchema.parse(value);
  const expectedUrlPrefix = `https://github.com/${repository}/pull/${String(pullRequestNumber)}#pullrequestreview-`;
  if (review.repository !== repository || review.pullRequestNumber !== pullRequestNumber || review.commitSha !== commitSha ||
    !review.reviewUrl.startsWith(expectedUrlPrefix) || !allowedAuthors.includes(review.sourceIdentity.toLocaleLowerCase("en-US"))) {
    throw new HarnessOutputInvalid();
  }
  return review;
}

function qodoGithubReviewV1Schema(
  repository: string,
  pullRequestNumber: number,
  commitSha: string,
  allowedAuthors: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    additionalProperties: false,
    required: ["schemaVersion", "repository", "pullRequestNumber", "reviewId", "reviewUrl", "sourceIdentity", "sourceReceipt", "commitSha", "testsPassed", "complete", "comments"],
    fields: {
      schemaVersion: { const: "qodo_github_review_v1" },
      repository: { const: repository },
      pullRequestNumber: { const: pullRequestNumber },
      reviewId: { type: "non-empty GitHub review identifier", maxLength: 128 },
      reviewUrl: { type: "canonical GitHub pull-request review URL", fragment: "pullrequestreview-<positive id>" },
      sourceIdentity: { enum: allowedAuthors, semantics: "authenticated GitHub review author; not a model assertion" },
      sourceReceipt: { type: "opaque authenticated provider receipt", minLength: 16, semantics: "must be returned by the GitHub evidence adapter and is verified outside this session" },
      commitSha: { const: commitSha },
      testsPassed: { type: "boolean", semantics: "true only when the authenticated review/check evidence proves the current commit tests passed" },
      complete: { type: "boolean", semantics: "false until the authenticated provider confirms the review is complete; false causes no gate mutation" },
      comments: { type: "array", maxItems: 1_000, semantics: "raw GitHub review comments; only configured Qodo authors can become Qodo findings" },
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
