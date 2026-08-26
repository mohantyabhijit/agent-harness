import type {
  CampaignPacket,
  HarnessOperation,
  HarnessPort,
  HarnessSessionResult,
} from "../../src/application/ports/harness.js";

export class FakeHarness implements HarnessPort {
  readonly operations: HarnessOperation[] = [];
  readonly parentSessions: string[] = [];
  readonly childSessions: string[] = [];
  readonly deletedSessions: string[] = [];
  readonly packets: CampaignPacket[] = [];
  readonly #results = new Map<HarnessOperation, HarnessSessionResult[]>();
  readonly #failures = new Map<HarnessOperation, Error[]>();
  #nextSession = 1;

  enqueueResult(operation: HarnessOperation, result: Omit<HarnessSessionResult, "sessionId">): void {
    const results = this.#results.get(operation) ?? [];
    results.push({ ...structuredClone(result), sessionId: "" });
    this.#results.set(operation, results);
  }

  enqueueFailure(operation: HarnessOperation, error: Error): void {
    const failures = this.#failures.get(operation) ?? [];
    failures.push(error);
    this.#failures.set(operation, failures);
  }

  async createParentSession(title: string): Promise<string> {
    void title;
    const sessionId = this.#sessionId();
    this.parentSessions.push(sessionId);
    return sessionId;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deletedSessions.push(sessionId);
  }

  async runChildSession(
    packet: CampaignPacket,
    operation: HarnessOperation,
  ): Promise<HarnessSessionResult> {
    const sessionId = this.#sessionId();
    this.operations.push(operation);
    this.childSessions.push(sessionId);
    this.packets.push(structuredClone(packet));
    const failure = this.#failures.get(operation)?.shift();
    if (failure !== undefined) {
      throw failure;
    }
    const queued = this.#results.get(operation)?.shift();
    return {
      sessionId,
      summary: queued?.summary ?? `${operation} completed`,
      artifacts: queued?.artifacts ?? [`artifacts/${operation}-${sessionId}.json`],
      output: queued?.output ?? defaultOutput(operation),
    };
  }

  async streamSession(
    sessionId: string,
    packet: CampaignPacket,
    operation: HarnessOperation,
  ): Promise<AsyncIterable<unknown>> {
    void sessionId;
    void packet;
    void operation;
    return emptyStream();
  }

  async getSessionEvents(sessionId: string): Promise<readonly unknown[]> {
    void sessionId;
    return [];
  }

  #sessionId(): string {
    const sessionId = `session-${String(this.#nextSession)}`;
    this.#nextSession += 1;
    return sessionId;
  }
}

function defaultOutput(operation: HarnessOperation): unknown {
  if (operation === "preflight") {
    return {
      verdict: "pass",
      checks: [
        "manifest_and_lifecycle_scripts",
        "suspicious_paths",
        "credential_and_secret_boundary",
        "network_behavior",
        "repository_metadata",
      ],
      commitSha: "a".repeat(40),
      dependenciesInstalled: false,
      repositoryScriptsExecuted: false,
      evidence: [
        "manifest_and_lifecycle_scripts",
        "suspicious_paths",
        "credential_and_secret_boundary",
        "network_behavior",
        "repository_metadata",
      ].map((check) => ({
        check,
        sourceUrl: `https://github.com/owner/repo/blob/${"a".repeat(40)}/package.json`,
        observation: `${check} inspected statically`,
      })),
    };
  }
  if (operation === "verify") {
    return { testsPassed: true };
  }
  return { status: "completed" };
}

async function* emptyStream() {
  yield* [];
}
