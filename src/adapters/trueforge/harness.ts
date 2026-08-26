import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

import type {
  CampaignPacket,
  HarnessOperation,
  HarnessPort,
  HarnessSessionResult,
} from "../../application/ports/harness.js";

const finalEnvelopeSchema = z
  .object({
    summary: z.string().trim().min(1),
    artifacts: z.array(z.string().min(1).refine(isSandboxArtifactPath)),
    output: z.unknown(),
  })
  .strict();

const nonNegativeNumber = z.number().nonnegative();
const turnMetricsSchema = z
  .object({
    totalCacheReadTokens: nonNegativeNumber.optional(),
    totalCacheWriteTokens: nonNegativeNumber.optional(),
    totalCostInUsd: nonNegativeNumber.optional(),
    totalInputTokens: nonNegativeNumber.optional(),
    totalOutputTokens: nonNegativeNumber.optional(),
    totalReasoningTokens: nonNegativeNumber.optional(),
    totalTokens: nonNegativeNumber.optional(),
  })
  .strict();
const modelMessageUsageSchema = z
  .object({
    cacheReadTokens: nonNegativeNumber.optional(),
    cacheWriteTokens: nonNegativeNumber.optional(),
    inputTokens: nonNegativeNumber,
    inputTokensBreakdown: z
      .object({
        harness: nonNegativeNumber,
        instructions: nonNegativeNumber,
        messages: nonNegativeNumber,
        skills: nonNegativeNumber,
        toolDefinitions: nonNegativeNumber,
      })
      .strict(),
    outputTokens: nonNegativeNumber,
  })
  .strict();

const modelMessageSchema = z
  .object({
    content: z
      .union([
        z.string(),
        z.array(
          z.discriminatedUnion("type", [
            z.object({ type: z.literal("text"), text: z.string() }).loose(),
            z.object({ type: z.literal("refusal"), refusal: z.string() }).loose(),
          ]),
        ),
      ])
      .nullable()
      .optional(),
    createdAt: z.iso.datetime(),
    finishReason: z
      .enum(["stop", "length", "tool_calls", "content_filter", "function_call"])
      .nullable()
      .optional(),
    id: z.string().min(1),
    name: z.string().optional(),
    reasoningContent: z.string().optional(),
    refusal: z.string().nullable().optional(),
    threadId: z.string().min(1),
    toolCalls: z.array(z.unknown()).optional(),
    type: z.literal("model.message"),
    usage: modelMessageUsageSchema.optional(),
  })
  .loose();

const turnCreatedSchema = z
  .object({
    createdAt: z.iso.datetime(),
    id: z.string().min(1),
    previousTurnId: z.string().min(1).nullable(),
    state: z.object({ status: z.literal("running") }).strict(),
    threadId: z.null(),
    turnId: z.string().min(1),
    type: z.literal("turn.created"),
  })
  .loose();

const turnDoneSchema = z
  .object({
    createdAt: z.iso.datetime(),
    id: z.string().min(1),
    threadId: z.null(),
    type: z.literal("turn.done"),
    state: z.discriminatedUnion("status", [
      z
        .object({
          completedAt: z.iso.datetime(),
          metrics: turnMetricsSchema.optional(),
          reason: z.enum([
            "server-execution-timeout",
            "client-cancelled",
            "cancelled-for-next-turn",
            "abandoned",
          ]),
          status: z.literal("cancelled"),
        })
        .loose(),
      z
        .object({
          completedAt: z.iso.datetime(),
          message: z.string(),
          metrics: turnMetricsSchema.optional(),
          status: z.literal("error"),
        })
        .loose(),
      z
        .object({
          completedAt: z.iso.datetime(),
          metrics: turnMetricsSchema.optional(),
          status: z.literal("done"),
          output: modelMessageSchema.nullable(),
          requiredActions: z.array(z.object({ type: z.string() }).loose()),
        })
        .loose(),
    ]),
  })
  .loose();

export class HarnessUnavailable extends Error {
  override readonly name = "HarnessUnavailable";

  constructor() {
    super("TrueForge is unavailable");
  }
}

export class HarnessAuthRequired extends Error {
  override readonly name = "HarnessAuthRequired";

  constructor() {
    super("TrueForge authentication is required");
  }
}

export class HarnessExecutionFailed extends Error {
  override readonly name = "HarnessExecutionFailed";

  constructor() {
    super("TrueForge execution failed");
  }
}

export class HarnessOutputInvalid extends Error {
  override readonly name = "HarnessOutputInvalid";

  constructor() {
    super("TrueForge returned invalid structured output");
  }
}

export class TrueForgeHarness implements HarnessPort {
  constructor(private readonly client: TrueForge) {}

  async createParentSession(title: string): Promise<string> {
    if (title.trim().length === 0) {
      throw new HarnessExecutionFailed();
    }

    try {
      return await this.createNamedSession();
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }

  async runChildSession(
    packet: CampaignPacket,
    operation: HarnessOperation,
  ): Promise<HarnessSessionResult> {
    try {
      // A session owns its sandbox in TrueForge. Creating one here ensures every
      // milestone or repair runs in a fresh child context and fresh sandbox.
      const sessionId = await this.createNamedSession();
      const stream = await this.streamSession(sessionId, packet, operation);
      const createdTurnIds: string[] = [];
      let terminalState: z.infer<typeof turnDoneSchema>["state"] | undefined;
      let terminalCount = 0;
      let eventAfterTerminal = false;
      let malformedLifecycleEvent = false;
      let authenticationRequired = false;

      for await (const event of stream) {
        if (terminalCount > 0) {
          eventAfterTerminal = true;
        }
        if (isMcpAuthRequired(event)) {
          authenticationRequired = true;
        }

        if (hasEventType(event, "turn.created")) {
          const turnCreated = turnCreatedSchema.safeParse(event);
          if (!turnCreated.success) {
            malformedLifecycleEvent = true;
          } else {
            createdTurnIds.push(turnCreated.data.turnId);
          }
        }

        if (hasEventType(event, "turn.done")) {
          terminalCount += 1;
          const turnDone = turnDoneSchema.safeParse(event);
          if (!turnDone.success) {
            malformedLifecycleEvent = true;
          } else {
            terminalState = turnDone.data.state;
          }
        }
      }

      if (authenticationRequired) {
        throw new HarnessAuthRequired();
      }
      if (malformedLifecycleEvent) {
        throw new HarnessOutputInvalid();
      }
      if (
        createdTurnIds.length !== 1 ||
        terminalCount !== 1 ||
        terminalState === undefined ||
        eventAfterTerminal
      ) {
        throw new HarnessExecutionFailed();
      }
      return parseCompletedTurn(sessionId, terminalState);
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }

  async streamSession(
    sessionId: string,
    packet: CampaignPacket,
    operation: HarnessOperation,
  ): Promise<AsyncIterable<unknown>> {
    try {
      const sdkStream = await this.client.sessions.createTurnStream(sessionId, {
        input: [{ type: "user.message", content: JSON.stringify({ operation, packet }) }],
        previousTurnId: "auto",
      });
      return normalizeStreamErrors(sdkStream);
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }

  async getSessionEvents(sessionId: string): Promise<readonly unknown[]> {
    try {
      // The pinned SDK returns core.Page as one AsyncIterable and follows
      // next_page_token internally; no separate cursor loop is needed here.
      const page = await this.client.sessions.listEvents(sessionId, { limit: 100 });
      const events: unknown[] = [];
      for await (const event of page) {
        events.push(event);
      }
      return events;
    } catch (error) {
      throw normalizeSdkError(error);
    }
  }

  private async createNamedSession(): Promise<string> {
    const created = await this.client.sessions.create({ agent: { name: "openquest" } });
    const sessionId = created.data.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new HarnessExecutionFailed();
    }
    return sessionId;
  }
}

function parseCompletedTurn(
  sessionId: string,
  state: z.infer<typeof turnDoneSchema>["state"],
): HarnessSessionResult {
  if (state.status !== "done") {
    throw new HarnessExecutionFailed();
  }
  if (state.requiredActions.some((action) => action.type === "mcp.auth_required")) {
    throw new HarnessAuthRequired();
  }
  if (state.requiredActions.length > 0 || state.output === null) {
    throw new HarnessExecutionFailed();
  }
  if (state.output.refusal !== undefined && state.output.refusal !== null) {
    throw new HarnessOutputInvalid();
  }
  if (
    state.output.finishReason !== "stop" ||
    (state.output.toolCalls !== undefined && state.output.toolCalls.length > 0)
  ) {
    throw new HarnessOutputInvalid();
  }

  const content = extractText(state.output.content);
  if (content === null) {
    throw new HarnessOutputInvalid();
  }

  try {
    const parsed = finalEnvelopeSchema.parse(JSON.parse(content) as unknown);
    return { sessionId, summary: parsed.summary, artifacts: parsed.artifacts, output: parsed.output };
  } catch {
    throw new HarnessOutputInvalid();
  }
}

function extractText(
  content:
    | string
    | readonly ({ type: "text"; text: string } | { type: "refusal"; refusal: string })[]
    | null
    | undefined,
): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return null;
  }
  const text: string[] = [];
  for (const part of content) {
    if (part.type === "refusal") {
      return null;
    }
    text.push(part.text);
  }
  return text.join("");
}

function isMcpAuthRequired(event: unknown): boolean {
  return hasEventType(event, "mcp.auth_required");
}

function hasEventType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && "type" in event && event.type === type;
}

function isSandboxArtifactPath(value: string): boolean {
  const normalizedSeparators = value.replaceAll("\\", "/");
  const pathSegments = normalizedSeparators.split("/");
  const hasControlCharacter = containsControlCharacter(value);
  return (
    value === value.trim() &&
    value === normalizedSeparators &&
    !hasControlCharacter &&
    !/[?#%:]/u.test(value) &&
    !value.startsWith("/") &&
    pathSegments[0] === "artifacts" &&
    pathSegments.length > 1 &&
    pathSegments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

async function* normalizeStreamErrors(source: AsyncIterable<unknown>): AsyncGenerator {
  try {
    yield* source;
  } catch (error) {
    throw normalizeSdkError(error);
  }
}

function normalizeSdkError(error: unknown): Error {
  if (
    error instanceof HarnessUnavailable ||
    error instanceof HarnessAuthRequired ||
    error instanceof HarnessExecutionFailed ||
    error instanceof HarnessOutputInvalid
  ) {
    return error;
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return new HarnessAuthRequired();
  }
  if (error instanceof TypeError || statusCode === undefined || statusCode >= 500) {
    return new HarnessUnavailable();
  }
  return new HarnessExecutionFailed();
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}
