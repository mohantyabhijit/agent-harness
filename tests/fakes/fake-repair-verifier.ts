import type { RepairVerificationRequest, RepairVerifierPort, VerifiedRepair } from "../../src/application/ports/repair-verifier.js";

export class FakeRepairVerifier implements RepairVerifierPort {
  readonly requests: RepairVerificationRequest[] = [];
  failure?: Error;
  result?: VerifiedRepair;

  async verify(request: RepairVerificationRequest): Promise<VerifiedRepair> {
    this.requests.push(structuredClone(request));
    if (this.failure !== undefined) throw this.failure;
    return this.result ?? {
      commitSha: request.candidate.commitSha,
      sandboxSessionId: `sandbox:${request.childSessionId}`,
      commands: request.candidate.verification.commands,
      evidence: request.candidate.verification.evidence,
    };
  }
}
