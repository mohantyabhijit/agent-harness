import type { QodoFinding } from "../../domain/quality-gate.js";
import type { CampaignPacket, HarnessRequestOptions } from "./harness.js";

export interface QodoReview {
  readonly reviewId: string;
  readonly commitSha: string;
  readonly testsPassed: boolean;
  readonly complete: boolean;
  readonly findings: readonly QodoFinding[];
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
