import { z } from "zod";

import type { CampaignPacket, HarnessPort } from "../../application/ports/harness.js";
import { HarnessError, HarnessOutputInvalid } from "../../application/ports/harness.js";
import type { QodoReview, QodoReviewPort, QodoReviewRequest } from "../../application/ports/qodo-review.js";
import { parseQodoReviewComments } from "./github-review-parser.js";

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
  repository: repositorySchema,
  pullRequestNumber: z.number().int().positive(),
  reviewId: z.string().trim().min(1).max(128),
  commitSha: commitSchema,
  testsPassed: z.boolean(),
  complete: z.boolean(),
  comments: z.array(z.unknown()).max(1_000),
}).strict();

export interface TrueForgeQodoReviewConfig {
  readonly allowlistedBotIdentities: readonly string[];
}

export class TrueForgeQodoReview implements QodoReviewPort {
  readonly #allowedAuthors: readonly string[];

  constructor(
    private readonly harness: HarnessPort,
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
      const packet: CampaignPacket = {
        campaignId: parsedPacket.campaignId,
        repository,
        issueNumber: parsedPacket.issueNumber,
        goal: `Retrieve the complete Qodo GitHub review for ${pullRequest}. Return only qodo_github_review_v1 structured output; do not perform GitHub writes.`,
        verifiedEvidence: parsedPacket.verifiedEvidence,
        approvals: parsedPacket.approvals,
        currentCommitSha: parsedPacket.currentCommitSha,
        context: {
          pullRequest,
          pullRequestNumber,
          commitSha: parsedPacket.currentCommitSha,
          allowedAuthors: this.#allowedAuthors,
          responseContract: "qodo_github_review_v1",
        },
      };
      const result = await this.harness.runChildSession(
        packet,
        "sync_qodo",
        requestOptions(request),
      );
      const review = reviewEnvelopeSchema.parse(result.output);
      if (
        review.repository !== repository ||
        review.pullRequestNumber !== pullRequestNumber ||
        review.commitSha !== parsedPacket.currentCommitSha
      ) {
        throw new HarnessOutputInvalid();
      }
      const findings = parseQodoReviewComments(review.comments, {
        repository,
        pullRequestNumber,
        allowlistedBotIdentities: this.#allowedAuthors,
      });
      if (!review.complete && findings.length === 0) throw new HarnessOutputInvalid();
      return {
        reviewId: review.reviewId,
        commitSha: review.commitSha,
        testsPassed: review.testsPassed,
        complete: review.complete,
        findings,
      };
    } catch (error) {
      if (isHarnessError(error)) throw error;
      throw new HarnessOutputInvalid();
    }
  }
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
