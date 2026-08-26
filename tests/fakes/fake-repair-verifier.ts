import type { RepairVerificationRequest, RepairVerifierPort, VerifiedRepair } from "../../src/application/ports/repair-verifier.js";

export class FakeRepairVerifier implements RepairVerifierPort {
  readonly requests: RepairVerificationRequest[] = [];
  failure?: Error;
  result?: VerifiedRepair;

  async verify(request: RepairVerificationRequest): Promise<VerifiedRepair> {
    this.requests.push(structuredClone(request));
    if (this.failure !== undefined) throw this.failure;
    return this.result ?? {
      receipt: `verified-repair:${request.campaignId}:${request.childSessionId}`,
      campaignId: request.campaignId,
      repository: request.repository,
      pullRequest: request.pullRequest,
      childSessionId: request.childSessionId,
      sandboxSessionId: `sandbox:${request.childSessionId}`,
      expectedParentCommitSha: request.expectedParentCommitSha,
      candidateCommitSha: request.candidate.commitSha,
      testPolicy: request.testPolicy,
      testsPassed: true,
      commands: request.candidate.verification.commands,
      evidence: request.candidate.verification.evidence,
    };
  }
}
