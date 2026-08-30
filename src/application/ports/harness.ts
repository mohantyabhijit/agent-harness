export interface CampaignPacket {
  campaignId: string;
  repository: string;
  issueNumber: number;
  goal: string;
  verifiedEvidence: readonly { sourceUrl: string; observation: string }[];
  approvals: readonly { action: string; digest: string; status: string }[];
  currentCommitSha?: string;
  context?: Readonly<Record<string, unknown>>;
}

// These are sent with production implementation and verification turns. Keep
// this contract in the shared port so the production prompt and the
// application parsers cannot silently drift apart.
export const campaignOperationResponseSchemas = {
  implement: {
    type: "object",
    additionalProperties: false,
    required: ["status", "commitSha", "changedAreas", "tests", "uncertainty", "before", "after"],
    properties: {
      status: { const: "completed" },
      commitSha: { type: "string", pattern: "^[0-9a-f]{40}$", description: "A new lowercase commit SHA, different from the current head." },
      changedAreas: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      tests: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      uncertainty: { type: "string", minLength: 1, maxLength: 2_000 },
      before: { type: "string", minLength: 1, maxLength: 2_000 },
      after: { type: "string", minLength: 1, maxLength: 2_000 },
    },
  },
  verify: {
    type: "object",
    additionalProperties: false,
    required: ["testsPassed", "currentCommitSha", "tests", "uncertainty"],
    properties: {
      testsPassed: { const: true },
      currentCommitSha: { type: "string", pattern: "^[0-9a-f]{40}$", description: "Exactly the current implementation commit SHA." },
      tests: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 2_000 } },
      uncertainty: { type: "string", minLength: 1, maxLength: 2_000 },
    },
  },
} as const;

export type HarnessOperation =
  | "discover"
  | "policy"
  | "preflight"
  | "implement"
  | "verify"
  | "sync_qodo"
  | "repair";

export interface HarnessSessionResult {
  sessionId: string;
  summary: string;
  artifacts: readonly string[];
  output: unknown;
}

export interface HarnessRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly sessionLifecycle?: "durable" | "transient";
  readonly sessionProfile?: "default" | "policy";
}

export type HarnessErrorCode = "auth_required" | "execution_failed" | "invalid_output" | "unavailable";

export class HarnessError extends Error {
  override readonly name = "HarnessError";
  constructor(readonly code: HarnessErrorCode) {
    super(`Harness ${code}`);
  }
}

export class HarnessUnavailable extends HarnessError { constructor() { super("unavailable"); } }
export class HarnessAuthRequired extends HarnessError { constructor() { super("auth_required"); } }
export class HarnessExecutionFailed extends HarnessError { constructor() { super("execution_failed"); } }
export class HarnessOutputInvalid extends HarnessError { constructor() { super("invalid_output"); } }

export interface HarnessPort {
  createParentSession(title: string, options?: HarnessRequestOptions): Promise<string>;
  deleteSession(sessionId: string, options?: HarnessRequestOptions): Promise<void>;
  runChildSession(packet: CampaignPacket, operation: HarnessOperation, options?: HarnessRequestOptions): Promise<HarnessSessionResult>;
  streamSession(
    sessionId: string,
    packet: CampaignPacket,
    operation: HarnessOperation,
    options?: HarnessRequestOptions,
  ): Promise<AsyncIterable<unknown>>;
  getSessionEvents(sessionId: string, options?: HarnessRequestOptions): Promise<readonly unknown[]>;
}
