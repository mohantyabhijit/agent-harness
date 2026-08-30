import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { CampaignPacket } from "../../../../src/application/ports/harness.js";
import {
  HarnessAuthRequired,
  HarnessExecutionFailed,
  HarnessOutputInvalid,
  HarnessUnavailable,
  TrueForgeHarness,
} from "../../../../src/adapters/trueforge/harness.js";

const packet: CampaignPacket = {
  campaignId: "campaign-42",
  repository: "owner/repo",
  issueNumber: 42,
  goal: "Implement the verified issue scope",
  verifiedEvidence: [
    {
      sourceUrl: "https://github.com/owner/repo/issues/42",
      observation: "The acceptance criteria are explicit.",
    },
  ],
  approvals: [],
};

describe("TrueForgeHarness", () => {
  it("creates a named parent session for one issue campaign", async () => {
    const client = { sessions: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }) } };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.createParentSession("owner/repo#42")).resolves.toBe("session-1");
    expect(client.sessions.create).toHaveBeenCalledWith({ agent: { name: "openquest" } });
  });

  it("passes injected cancellation and timeout options to the SDK", async () => {
    const controller = new AbortController();
    const client = { sessions: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }) } };
    const harness = new TrueForgeHarness(client as never);

    await harness.createParentSession("owner/repo#42", { signal: controller.signal, timeoutMs: 1_500 });

    expect(client.sessions.create).toHaveBeenCalledWith({ agent: { name: "openquest" } }, { abortSignal: controller.signal, timeoutInSeconds: 2 });
  });

  it("deletes an unused parent session for campaign-creation compensation", async () => {
    const client = { sessions: { delete: vi.fn().mockResolvedValue(undefined) } };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.deleteSession("session-1")).resolves.toBeUndefined();
    expect(client.sessions.delete).toHaveBeenCalledWith("session-1");
  });

  it("normalizes session-deletion failures without exposing the SDK payload", async () => {
    const sdkError = Object.assign(new Error("token=top-secret"), { statusCode: 401 });
    const client = { sessions: { delete: vi.fn().mockRejectedValue(sdkError) } };
    const harness = new TrueForgeHarness(client as never);

    const result = harness.deleteSession("session-1");
    await expect(result).rejects.toBeInstanceOf(HarnessAuthRequired);
    await expect(result).rejects.not.toThrow(/top-secret/u);
  });

  it("runs a milestone in a fresh named session and returns only its final envelope", async () => {
    const events = await loadSessionEvents();
    let consumed = 0;
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(stream(events, () => consumed++)),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "implement")).resolves.toEqual({
      sessionId: "child-session-1",
      summary: "Verified the smallest patch in a fresh sandbox.",
      artifacts: ["artifacts/change-brief.md"],
      output: { status: "verified" },
    });
    expect(client.sessions.create).toHaveBeenCalledWith({ agent: { name: "openquest" } });
    expect(client.sessions.createTurnStream).toHaveBeenCalledWith(
      "child-session-1",
      {
        input: [{ type: "user.message", content: JSON.stringify({ operation: "implement", packet }) }],
        previousTurnId: "auto",
      },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(consumed).toBe(events.length);
  });

  it("deletes transient child sessions after success", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(stream(await loadSessionEvents())),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "discover", { sessionLifecycle: "transient" })).resolves.toMatchObject({ sessionId: "child-session-1" });
    expect(client.sessions.delete).toHaveBeenCalledWith("child-session-1");
  });

  it("deletes transient child sessions when execution fails after allocation", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockRejectedValue(new Error("stream failed")),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "discover", { sessionLifecycle: "transient" })).rejects.toBeInstanceOf(HarnessUnavailable);
    expect(client.sessions.delete).toHaveBeenCalledWith("child-session-1");
  });

  it("does not let transient cleanup failure replace a successful result", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(stream(await loadSessionEvents())),
        delete: vi.fn().mockRejectedValue(Object.assign(new Error("cleanup auth"), { statusCode: 401 })),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "discover", { sessionLifecycle: "transient" })).resolves.toMatchObject({ sessionId: "child-session-1" });
  });

  it("does not let transient cleanup failure mask the original execution error", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockRejectedValue(new Error("stream failed")),
        delete: vi.fn().mockRejectedValue(Object.assign(new Error("cleanup auth"), { statusCode: 401 })),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "discover", { sessionLifecycle: "transient" })).rejects.toBeInstanceOf(HarnessUnavailable);
  });

  it("returns after a terminal event when the provider leaves the stream open", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(openEndedAfterTerminalStream()),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "discover")).resolves.toMatchObject({
      sessionId: "child-session-1",
    });
  });

  it("returns persisted events across every SDK page", async () => {
    const pageItems = [
      { turnId: "turn-2", event: { type: "turn.done" } },
      { turnId: "turn-1", event: { type: "turn.created" } },
      { turnId: "turn-1", event: { type: "model.message" } },
    ];
    const client = {
      sessions: {
        listEvents: vi.fn().mockResolvedValue(stream(pageItems)),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.getSessionEvents("session-1")).resolves.toEqual(pageItems);
    expect(client.sessions.listEvents).toHaveBeenCalledWith("session-1", { limit: 100 });
  });

  it("normalizes authentication failures without exposing the SDK payload", async () => {
    const sdkError = Object.assign(new Error("token=top-secret"), {
      statusCode: 401,
      body: { token: "top-secret" },
    });
    const client = { sessions: { create: vi.fn().mockRejectedValue(sdkError) } };
    const harness = new TrueForgeHarness(client as never);

    const result = harness.createParentSession("owner/repo#42");
    await expect(result).rejects.toBeInstanceOf(HarnessAuthRequired);
    await expect(result).rejects.not.toThrow(/top-secret/);
  });

  it("normalizes connection failures as unavailable", async () => {
    const client = { sessions: { create: vi.fn().mockRejectedValue(new TypeError("fetch failed")) } };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.createParentSession("owner/repo#42")).rejects.toBeInstanceOf(
      HarnessUnavailable,
    );
  });

  it("fails closed when a streamed turn requests MCP authentication", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(
          stream([
            {
              type: "mcp.auth_required",
              mcpServers: [{ name: "github", authUrl: "https://example.invalid/secret" }],
            },
          ]),
        ),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessAuthRequired,
    );
  });

  it("preserves authentication failures from late stream events", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      turnDoneEvent(),
      { type: "mcp.auth_required", mcpServers: [{ name: "github", authUrl: "https://example.invalid/secret" }] },
    ]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessAuthRequired,
    );
  });

  it("fails closed when the stream ends without a successful turn", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(stream([])),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "repair")).rejects.toBeInstanceOf(
      HarnessExecutionFailed,
    );
  });

  it("rejects a top-level model refusal even when content contains valid JSON", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      turnDoneEvent({ refusal: "I cannot provide this result." }),
    ]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["length", { finishReason: "length" }],
    ["tool calls", { finishReason: "tool_calls" }],
    ["content filter", { finishReason: "content_filter" }],
    ["function call", { finishReason: "function_call" }],
    ["missing finish reason", { includeFinishReason: false }],
    ["unknown finish reason", { finishReason: "unexpected" }],
    ["non-empty terminal tool calls", { toolCalls: [{ id: "call-1" }] }],
  ])("rejects an incomplete terminal model message: %s", async (_label, options) => {
    const harness = harnessStreaming([turnCreatedEvent(), turnDoneEvent(options)]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects duplicate terminal events after consuming the full stream", async () => {
    const harness = harnessStreaming([turnCreatedEvent(), turnDoneEvent(), turnDoneEvent()]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessExecutionFailed,
    );
  });

  it("rejects a malformed terminal event instead of treating it as absent", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      { type: "turn.done", state: { status: "done" } },
    ]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects a terminal event followed by conflicting stream content", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      turnDoneEvent(),
      {
        createdAt: "2026-08-26T00:00:02Z",
        id: "late-message",
        threadId: "main",
        type: "model.message",
        content: "conflicting content",
      },
    ]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessExecutionFailed,
    );
  });

  it("rejects multiple turn-created identities in one child stream", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      { ...turnCreatedEvent(), turnId: "turn-2", id: "event-created-2" },
      turnDoneEvent(),
    ]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessExecutionFailed,
    );
  });

  it("normalizes stream iteration failures without leaking their message", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(throwingStream("token=top-secret")),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    const result = harness.runChildSession(packet, "verify");
    await expect(result).rejects.toBeInstanceOf(HarnessUnavailable);
    await expect(result).rejects.not.toThrow(/top-secret/u);
  });

  it.each([
    ["parent traversal", "artifacts/../credentials"],
    ["encoded traversal", "artifacts/%2e%2e/credentials"],
    ["empty segment", "artifacts//change.md"],
    ["dot segment", "artifacts/./change.md"],
    ["UNC root", "\\\\server\\share"],
    ["backslash root", "\\credentials"],
    ["device root", "\\\\?\\C:\\credentials"],
    ["drive root", "C:\\credentials"],
    ["forward-slash absolute", "/artifacts/change.md"],
    ["file URI", "file:artifacts/change.md"],
    ["HTTPS URI", "https://example.com/artifacts/change.md"],
    ["query trick", "artifacts/change.md?path=../credentials"],
    ["fragment trick", "artifacts/change.md#../credentials"],
    ["control character", "artifacts/change\n.md"],
  ])("rejects non-canonical artifact paths: %s", async (_label, artifact) => {
    const harness = harnessStreaming([turnCreatedEvent(), turnDoneEvent({ artifacts: [artifact] })]);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("accepts a canonical artifact path rooted under artifacts", async () => {
    const harness = harnessStreaming([
      turnCreatedEvent(),
      turnDoneEvent({ artifacts: ["artifacts/reports/change-brief.md"] }),
    ]);

    await expect(harness.runChildSession(packet, "verify")).resolves.toMatchObject({
      artifacts: ["artifacts/reports/change-brief.md"],
    });
  });
});

function harnessStreaming(events: readonly unknown[]): TrueForgeHarness {
  return new TrueForgeHarness({
    sessions: {
      create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
      createTurnStream: vi.fn().mockResolvedValue(stream(events)),
    },
  } as never);
}

function turnCreatedEvent(): Record<string, unknown> {
  return {
    createdAt: "2026-08-26T00:00:00Z",
    id: "event-created",
    previousTurnId: null,
    state: { status: "running" },
    threadId: null,
    turnId: "turn-1",
    type: "turn.created",
  };
}

function turnDoneEvent(
  options: {
    artifacts?: readonly string[];
    finishReason?: string;
    includeFinishReason?: boolean;
    refusal?: string;
    toolCalls?: readonly unknown[];
  } = {},
): Record<string, unknown> {
  return {
    createdAt: "2026-08-26T00:00:01Z",
    id: "event-done",
    threadId: null,
    type: "turn.done",
    state: {
      completedAt: "2026-08-26T00:00:01Z",
      status: "done",
      requiredActions: [],
      output: {
        createdAt: "2026-08-26T00:00:01Z",
        id: "event-final-message",
        threadId: "main",
        type: "model.message",
        ...(options.includeFinishReason === false
          ? {}
          : { finishReason: options.finishReason ?? "stop" }),
        ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
        content: JSON.stringify({
          summary: "Verified result",
          artifacts: options.artifacts ?? ["artifacts/change-brief.md"],
          output: { status: "verified" },
        }),
        ...(options.refusal === undefined ? {} : { refusal: options.refusal }),
      },
    },
  };
}

async function loadSessionEvents(): Promise<readonly unknown[]> {
  const contents = await readFile(
    new URL("../../../../fixtures/trueforge/session-events.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(contents) as readonly unknown[];
}

async function* stream(
  items: readonly unknown[],
  onItem: () => void = () => undefined,
): AsyncGenerator {
  for (const item of items) {
    onItem();
    yield item;
  }
}

async function* throwingStream(message: string): AsyncGenerator {
  yield turnCreatedEvent();
  throw new Error(message);
}

async function* openEndedAfterTerminalStream(): AsyncGenerator {
  yield turnCreatedEvent();
  yield turnDoneEvent();
  await new Promise<never>(() => undefined);
}
