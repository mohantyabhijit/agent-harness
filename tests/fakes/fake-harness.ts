import type {
  CampaignPacket,
  HarnessOperation,
  HarnessPort,
  HarnessSessionResult,
  HarnessRequestOptions,
} from "../../src/application/ports/harness.js";

export class FakeHarness implements HarnessPort {
  readonly operations: HarnessOperation[] = [];
  readonly parentSessions: string[] = [];
  readonly childSessions: string[] = [];
  readonly deletedSessions: string[] = [];
  readonly packets: CampaignPacket[] = [];
  readonly requestOptions: (HarnessRequestOptions | undefined)[] = [];
  readonly #results = new Map<HarnessOperation, HarnessSessionResult[]>();
  readonly #failures = new Map<HarnessOperation, Error[]>();
  beforeResult?: (operation: HarnessOperation) => Promise<void>;
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
    options?: HarnessRequestOptions,
  ): Promise<HarnessSessionResult> {
    const sessionId = this.#sessionId();
    this.operations.push(operation);
    this.childSessions.push(sessionId);
    this.packets.push(structuredClone(packet));
    this.requestOptions.push(options);
    const failure = this.#failures.get(operation)?.shift();
    if (failure !== undefined) {
      if (options?.sessionLifecycle === "transient") this.deletedSessions.push(sessionId);
      throw failure;
    }
    const beforeResult = this.beforeResult;
    delete this.beforeResult;
    await beforeResult?.(operation);
    const queued = this.#results.get(operation)?.shift();
    const result = {
      sessionId,
      summary: queued?.summary ?? `${operation} completed`,
      artifacts: queued?.artifacts ?? [`artifacts/${operation}-${sessionId}.json`],
      output: queued?.output ?? defaultOutput(operation),
    };
    if (options?.sessionLifecycle === "transient") this.deletedSessions.push(sessionId);
    return result;
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
  if (operation === "policy") {
    return {
      problem: "The selected issue describes behavior that does not match the repository contract.",
      likelyCause: "The affected path lacks the narrow guard required by the issue.",
      smallestFix: "Add the focused guard and a regression test without unrelated refactoring.",
      affectedAreas: ["src/affected-path.ts"],
      tests: ["Run the focused regression test and the repository test suite."],
      risks: ["The guard could reject a previously accepted edge case."],
      uncertainty: "The exact file remains subject to sandbox inspection after finalization.",
      evidence: [{ sourceUrl: "https://github.com/owner/repo/issues/42", observation: "The selected issue defines the reported behavior and expected outcome." }],
    };
  }
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
  if (operation === "repair") {
    return {
      status: "completed",
      commitSha: "c".repeat(40),
      verification: {
        testsPassed: true,
        commands: ["npm test"],
        evidence: [{ kind: "direct", sourceUrl: "https://github.com/owner/repo/actions/runs/1", observation: "All tests passed for the repair commit" }],
      },
    };
  }
  return { status: "completed" };
}

async function* emptyStream() {
  yield* [];
}
