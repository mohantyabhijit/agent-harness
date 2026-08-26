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
    artifacts: z.array(
      z
        .string()
        .trim()
        .min(1)
        .refine(isSandboxArtifactPath),
    ),
    output: z.unknown(),
  })
  .strict();

const turnDoneSchema = z
  .object({
    type: z.literal("turn.done"),
    state: z.discriminatedUnion("status", [
      z.object({ status: z.literal("cancelled") }).loose(),
      z.object({ status: z.literal("error") }).loose(),
      z
        .object({
          status: z.literal("done"),
          output: z
            .object({
              content: z.union([
                z.string(),
                z.array(
                  z.discriminatedUnion("type", [
                    z.object({ type: z.literal("text"), text: z.string() }),
                    z.object({ type: z.literal("refusal"), refusal: z.string() }),
                  ]),
                ),
              ])
              .nullable()
              .optional(),
            })
            .loose()
            .nullable(),
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

      for await (const event of stream) {
        if (isMcpAuthRequired(event)) {
          throw new HarnessAuthRequired();
        }

        const turnDone = turnDoneSchema.safeParse(event);
        if (!turnDone.success) {
          continue;
        }

        return parseCompletedTurn(sessionId, turnDone.data.state);
      }

      throw new HarnessExecutionFailed();
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
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    event.type === "mcp.auth_required"
  );
}

function isSandboxArtifactPath(value: string): boolean {
  const pathSegments = value.replaceAll("\\", "/").split("/");
  return (
    !value.includes("\0") &&
    !/^[a-z][a-z\d+.-]*:\/\//iu.test(value) &&
    !value.startsWith("/") &&
    !/^[a-z]:[\\/]/iu.test(value) &&
    !pathSegments.includes("..")
  );
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
