import type { QodoFinding } from "../../domain/quality-gate.js";
import type { CampaignPacket, HarnessRequestOptions } from "./harness.js";

export interface QodoReview {
  readonly syncSessionId: string;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly sourceIdentity: string;
  readonly sourceReceipt: string;
  readonly commitSha: string;
  readonly testsPassed: boolean;
  readonly complete: boolean;
  readonly findings: readonly QodoFinding[];
}

export interface QodoReviewCandidate {
  readonly schemaVersion: "qodo_github_review_v1";
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly sourceIdentity: string;
  readonly sourceReceipt: string;
  readonly commitSha: string;
  readonly testsPassed: boolean;
  readonly complete: boolean;
  readonly comments: readonly unknown[];
}

/**
 * Trust boundary for Qodo evidence. Implementations must authenticate the
 * GitHub review independently of model output (for example with an injected
 * GitHub App/MCP adapter) and return the canonical server-side evidence.
 */
export interface QodoReviewAuthorityPort {
  authenticate(
    candidate: QodoReviewCandidate,
    request: HarnessRequestOptions,
  ): Promise<QodoReviewCandidate>;
}

export interface QodoReviewRequest extends HarnessRequestOptions {
  readonly packet: CampaignPacket;
}

export interface QodoReviewPort {
  getReview(
    repository: string,
    pullRequestNumber: number,
    request: QodoReviewRequest,
  ): Promise<QodoReview>;
}
