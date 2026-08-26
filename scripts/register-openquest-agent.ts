import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

const agentManifestSchema = z
  .object({
    model: z
      .object({
        name: z.literal("openai/gpt-5-6-luna"),
        params: z.object({ reasoning_effort: z.literal("medium") }).strict(),
      })
      .strict(),
    instructions: z.string().min(1),
    mcp_servers: z.tuple([
      z
        .object({
          name: z.literal("github"),
          enable_tools: z.tuple([z.literal("@all")]),
          disable_tools: z.tuple([]),
          preload_tools: z.tuple([]),
          require_approval_for_tools: z.tuple([
            z.literal("@write"),
            z.literal("@destructive"),
          ]),
          preload: z.literal(false),
        })
        .strict(),
    ]),
    skills: z.tuple([z.object({ name: z.literal("openquest") }).strict()]),
    config: z
      .object({
        iteration_limit: z.literal(100),
        sandbox: z.object({ enabled: z.literal(true), file_downloads: z.boolean() }).strict(),
        dynamic_sub_agents: z.object({ enabled: z.literal(true) }).strict(),
        context_management: z
          .object({
            compaction: z.object({ enabled: z.literal(true) }).strict(),
            large_tool_response: z.object({ enabled: z.literal(true) }).strict(),
          })
          .strict(),
        generative_ui: z.object({ enabled: z.literal(true) }).strict(),
        ask_user_questions: z.object({ enabled: z.literal(true) }).strict(),
      })
      .strict(),
  })
  .strict();

export interface RegistrationCheck {
  trueforge: { reachable: boolean };
  githubMcp: { configured: boolean; authorized: boolean; ready: boolean };
  daytona: { configured: boolean; status: "failed" | "pending" | "ready" | "unknown"; ready: boolean };
  openquest: { skillRegistered: boolean; agentRegistered: boolean };
}

interface RegistrationResult {
  skill: "created-or-replaced";
  agent: "created" | "replaced";
}

const openQuestSkillManifest: TrueForgeApi.SkillManifest = {
  name: "openquest",
  description:
    "Run a source-linked, sandbox-isolated open-source contribution campaign with approval-gated GitHub writes.",
  type: "git",
  url: process.env.OPENQUEST_SKILL_GIT_URL ?? "https://github.com/mohantyabhijit/agent-harness.git",
  ref: process.env.OPENQUEST_SKILL_GIT_REF ?? "main",
  path: "skills/openquest",
};

export async function checkRegistration(client: TrueForge): Promise<RegistrationCheck> {
  const [agents, skills, mcpServers, sandboxProvider] = await Promise.all([
    safely(() => client.agents.list()),
    safely(() => client.settings.skills.list()),
    safely(() => client.settings.mcpServers.list()),
    safely(() => client.settings.sandboxProviders.get()),
  ]);
  const github = mcpServers?.data.find((server) => server.name === "github");
  const githubAuthorized =
    github?.authStatus.status === "authenticated" || github?.authStatus.status === "not_required";
  const daytonaConfigured = sandboxProvider?.data.manifest.type === "daytona";
  const daytonaStatus = sandboxProvider?.data.status ?? "unknown";

  return {
    trueforge: { reachable: agents !== null || skills !== null || mcpServers !== null },
    githubMcp: {
      configured: github !== undefined,
      authorized: githubAuthorized,
      ready: github !== undefined && githubAuthorized,
    },
    daytona: {
      configured: daytonaConfigured,
      status: daytonaStatus,
      ready: daytonaConfigured && daytonaStatus === "ready",
    },
    openquest: {
      skillRegistered: skills?.data.some((skill) => skill.name === "openquest") ?? false,
      agentRegistered: agents?.data.some((agent) => agent.name === "openquest") ?? false,
    },
  };
}

export async function registerOpenQuest(
  client: TrueForge,
  manifest: TrueForgeApi.AgentSpec,
): Promise<RegistrationResult> {
  const readiness = await checkRegistration(client);
  if (!readiness.trueforge.reachable || !readiness.githubMcp.ready || !readiness.daytona.ready) {
    throw new Error("TrueForge, GitHub MCP, and Daytona must be ready before registration");
  }

  await client.settings.skills.createOrUpdate({ manifest: openQuestSkillManifest });

  const agents = await client.agents.list();
  const matches = agents.data.filter((agent) => agent.name === "openquest");
  if (matches.length > 1) {
    throw new Error("OpenQuest agent registration is ambiguous");
  }
  const existing = matches[0];
  if (existing === undefined) {
    await client.agents.create({ name: "openquest", manifest });
    return { skill: "created-or-replaced", agent: "created" };
  }

  await client.agents.update(existing.id, { manifest });
  return { skill: "created-or-replaced", agent: "replaced" };
}

async function loadAgentManifest(): Promise<TrueForgeApi.AgentSpec> {
  const raw = await readFile(new URL("../config/agents/openquest.json", import.meta.url), "utf8");
  const manifest = agentManifestSchema.parse(JSON.parse(raw) as unknown);
  return {
    model: {
      name: manifest.model.name,
      params: { reasoningEffort: manifest.model.params.reasoning_effort },
    },
    instructions: manifest.instructions,
    mcpServers: manifest.mcp_servers.map((server) => ({
      name: server.name,
      enableTools: server.enable_tools,
      disableTools: server.disable_tools,
      preloadTools: server.preload_tools,
      requireApprovalForTools: server.require_approval_for_tools,
      preload: server.preload,
    })),
    skills: manifest.skills,
    config: {
      iterationLimit: manifest.config.iteration_limit,
      sandbox: {
        enabled: manifest.config.sandbox.enabled,
        fileDownloads: manifest.config.sandbox.file_downloads,
      },
      dynamicSubAgents: { enabled: manifest.config.dynamic_sub_agents.enabled },
      contextManagement: {
        compaction: { enabled: manifest.config.context_management.compaction.enabled },
        largeToolResponse: {
          enabled: manifest.config.context_management.large_tool_response.enabled,
        },
      },
      generativeUi: { enabled: manifest.config.generative_ui.enabled },
      askUserQuestions: { enabled: manifest.config.ask_user_questions.enabled },
    },
  };
}

async function safely<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const token = process.env.TRUEFORGE_TOKEN;
  const client = new TrueForge({
    baseUrl: process.env.TRUEFORGE_URL ?? "http://127.0.0.1:8790",
    ...(token === undefined || token.length === 0 ? {} : { token }),
    logging: { silent: true },
    timeoutInSeconds: 3,
    maxRetries: 0,
  });

  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await checkRegistration(client), null, 2));
    return;
  }

  const result = await registerOpenQuest(client, await loadAgentManifest());
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(() => {
    console.error("OpenQuest registration failed; run with --check for readiness details");
    process.exitCode = 1;
  });
}
