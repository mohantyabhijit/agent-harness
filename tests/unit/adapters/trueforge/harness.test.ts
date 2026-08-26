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
    expect(client.sessions.createTurnStream).toHaveBeenCalledWith("child-session-1", {
      input: [{ type: "user.message", content: JSON.stringify({ operation: "implement", packet }) }],
      previousTurnId: "auto",
    });
    expect(consumed).toBe(2);
  });

  it("returns all persisted session events from the SDK page", async () => {
    const pageItems = [
      { turnId: "turn-2", event: { type: "turn.done" } },
      { turnId: "turn-1", event: { type: "turn.created" } },
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

  it("rejects artifact paths that can escape the session sandbox", async () => {
    const client = {
      sessions: {
        create: vi.fn().mockResolvedValue({ data: { id: "child-session-1" } }),
        createTurnStream: vi.fn().mockResolvedValue(
          stream([
            {
              type: "turn.done",
              state: {
                status: "done",
                requiredActions: [],
                output: {
                  content: JSON.stringify({
                    summary: "Unsafe artifact claim",
                    artifacts: ["../credentials"],
                    output: {},
                  }),
                },
              },
            },
          ]),
        ),
      },
    };
    const harness = new TrueForgeHarness(client as never);

    await expect(harness.runChildSession(packet, "verify")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });
});

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
