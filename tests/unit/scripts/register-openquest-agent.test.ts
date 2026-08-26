import { describe, expect, it, vi } from "vitest";

import {
  checkRegistration,
  registerOpenQuest,
} from "../../../scripts/register-openquest-agent.js";

const trustedUrl = "https://github.com/mohantyabhijit/agent-harness.git";
const trustedRef = "0123456789abcdef0123456789abcdef01234567";
const agentManifest = { model: { name: "openai/gpt-5-6-luna" } };
const priorSkillManifest = {
  name: "openquest",
  description: "Previous trusted manifest",
  type: "git",
  url: trustedUrl,
  ref: "89abcdef0123456789abcdef0123456789abcdef",
  path: "skills/openquest",
};

describe("OpenQuest registration", () => {
  it("is idempotent and replaces the existing named agent on a second run", async () => {
    const state = fakeClient();

    await expect(
      registerOpenQuest(state.client as never, agentManifest, {
        skillUrl: trustedUrl,
        skillRef: trustedRef,
      }),
    ).resolves.toEqual({ skill: "created-or-replaced", agent: "created" });
    await expect(
      registerOpenQuest(state.client as never, agentManifest, {
        skillUrl: trustedUrl,
        skillRef: trustedRef,
      }),
    ).resolves.toEqual({ skill: "created-or-replaced", agent: "replaced" });

    expect(state.writes.createAgent).toHaveBeenCalledOnce();
    expect(state.writes.updateAgent).toHaveBeenCalledOnce();
    expect(state.writes.upsertSkill).toHaveBeenCalledTimes(2);
    expect(state.writes.upsertSkill).toHaveBeenLastCalledWith({
      manifest: expect.objectContaining({ url: trustedUrl, ref: trustedRef }),
    });
    expect(state.agents).toHaveLength(1);
  });

  it("keeps check mode non-mutating and reports a missing immutable ref as not ready", async () => {
    const state = fakeClient();

    await expect(
      checkRegistration(state.client as never, { skillUrl: trustedUrl }),
    ).resolves.toMatchObject({
      trustedSkill: { urlAllowed: true, immutableRef: false, ready: false },
    });
    expect(state.writes.createAgent).not.toHaveBeenCalled();
    expect(state.writes.updateAgent).not.toHaveBeenCalled();
    expect(state.writes.upsertSkill).not.toHaveBeenCalled();
  });

  it("reports credentialed or unapproved skill URLs as not ready without echoing them", async () => {
    const state = fakeClient();

    const report = await checkRegistration(state.client as never, {
      skillUrl: "https://token:top-secret@github.com/mohantyabhijit/agent-harness.git",
      skillRef: trustedRef,
    });

    expect(report.trustedSkill).toEqual({ urlAllowed: false, immutableRef: true, ready: false });
    expect(JSON.stringify(report)).not.toContain("top-secret");
  });

  it("rejects duplicate named agents before any mutation", async () => {
    const state = fakeClient({
      agents: [configuredAgent("agent-1"), configuredAgent("agent-2")],
    });

    await expect(
      registerOpenQuest(state.client as never, agentManifest, {
        skillUrl: trustedUrl,
        skillRef: trustedRef,
      }),
    ).rejects.toThrow("OpenQuest agent registration is ambiguous");
    expect(state.writes.createAgent).not.toHaveBeenCalled();
    expect(state.writes.updateAgent).not.toHaveBeenCalled();
    expect(state.writes.upsertSkill).not.toHaveBeenCalled();
  });

  it("restores the full existing skill manifest when agent replacement fails", async () => {
    const state = fakeClient({
      agents: [configuredAgent("agent-1")],
      skills: [{ name: "openquest", manifest: priorSkillManifest }],
      agentMutationError: new Error("token=top-secret"),
    });

    const result = registerOpenQuest(state.client as never, agentManifest, {
      skillUrl: trustedUrl,
      skillRef: trustedRef,
    });
    await expect(result).rejects.toThrow("OpenQuest registration failed; previous skill restored");
    await expect(result).rejects.not.toThrow(/top-secret/u);
    expect(state.writes.upsertSkill).toHaveBeenCalledTimes(2);
    expect(state.writes.upsertSkill).toHaveBeenLastCalledWith({ manifest: priorSkillManifest });
  });

  it("reports a fixed failure when agent creation leaves a new unreferenced skill", async () => {
    const state = fakeClient({ agentMutationError: new Error("token=top-secret") });

    const result = registerOpenQuest(state.client as never, agentManifest, {
      skillUrl: trustedUrl,
      skillRef: trustedRef,
    });
    await expect(result).rejects.toThrow(
      "OpenQuest agent registration failed; an unreferenced skill may remain",
    );
    await expect(result).rejects.not.toThrow(/top-secret/u);
    expect(state.writes.upsertSkill).toHaveBeenCalledOnce();
  });
});

function configuredAgent(id: string): Record<string, unknown> {
  return { id, name: "openquest", manifest: agentManifest };
}

function fakeClient(options: {
  agents?: Record<string, unknown>[];
  skills?: Record<string, unknown>[];
  agentMutationError?: Error;
} = {}) {
  const agents = [...(options.agents ?? [])];
  const skills = [...(options.skills ?? [])];
  const upsertSkill = vi.fn(async ({ manifest }: { manifest: Record<string, unknown> }) => {
    const existingIndex = skills.findIndex((skill) => skill.name === "openquest");
    const configured = { name: "openquest", manifest };
    if (existingIndex === -1) {
      skills.push(configured);
    } else {
      skills[existingIndex] = configured;
    }
    return { data: configured };
  });
  const createAgent = vi.fn(async ({ name, manifest }: Record<string, unknown>) => {
    if (options.agentMutationError !== undefined) {
      throw options.agentMutationError;
    }
    const configured = { id: "agent-created", name, manifest };
    agents.push(configured);
    return { data: configured };
  });
  const updateAgent = vi.fn(async (id: string, { manifest }: Record<string, unknown>) => {
    if (options.agentMutationError !== undefined) {
      throw options.agentMutationError;
    }
    const index = agents.findIndex((agent) => agent.id === id);
    agents[index] = { id, name: "openquest", manifest };
    return { data: agents[index] };
  });

  return {
    agents,
    skills,
    writes: { createAgent, updateAgent, upsertSkill },
    client: {
      agents: { list: vi.fn(async () => ({ data: agents })), create: createAgent, update: updateAgent },
      settings: {
        skills: { list: vi.fn(async () => ({ data: skills })), createOrUpdate: upsertSkill },
        mcpServers: {
          list: vi.fn(async () => ({
            data: [{ name: "github", authStatus: { status: "not_required" } }],
          })),
        },
        sandboxProviders: {
          get: vi.fn(async () => ({
            data: { manifest: { type: "daytona" }, status: "ready" },
          })),
        },
      },
    },
  };
}
