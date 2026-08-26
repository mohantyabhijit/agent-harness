import type { HarnessRequestOptions } from "./harness.js";

export interface RepairCandidate {
  readonly commitSha: string;
  readonly verification: {
    readonly testsPassed: true;
    readonly commands: readonly string[];
    readonly evidence: readonly { readonly kind: "direct"; readonly sourceUrl: string; readonly observation: string }[];
  };
}

export interface RepairVerificationRequest extends HarnessRequestOptions {
  readonly campaignId: string;
  readonly repository: string;
  readonly pullRequest: string;
  readonly childSessionId: string;
  readonly expectedParentCommitSha: string;
  readonly candidate: RepairCandidate;
}

export interface VerifiedRepair {
  readonly commitSha: string;
  readonly sandboxSessionId: string;
  readonly commands: readonly string[];
  readonly evidence: readonly { readonly kind: "direct"; readonly sourceUrl: string; readonly observation: string }[];
}

/** Independently proves commit ancestry/existence, sandbox ownership, and executed tests. */
export interface RepairVerifierPort {
  verify(request: RepairVerificationRequest): Promise<VerifiedRepair>;
}
