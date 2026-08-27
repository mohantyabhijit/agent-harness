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
          enable_tools: z.tuple([z.literal("@read-only")]),
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
  trustedSkill: { urlAllowed: boolean; immutableRef: boolean; ready: boolean };
}

interface RegistrationResult {
  skill: "created-or-replaced";
  agent: "created" | "replaced";
}

export interface RegistrationOptions {
  skillUrl?: string;
  skillRef?: string;
}

const trustedSkillUrl = "https://github.com/mohantyabhijit/agent-harness.git";
const immutableCommitPattern = /^[a-f\d]{40}$/iu;
const configuredAgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.literal("openquest"),
    manifest: z.object({ model: z.object({ name: z.string().min(1) }).loose() }).loose(),
  })
  .strict();
const configuredSkillSchema = z
  .object({
    name: z.literal("openquest"),
    manifest: z
      .object({
        description: z.string(),
        name: z.literal("openquest"),
        path: z.string().optional(),
        ref: z.string().min(1),
        type: z.literal("git"),
        url: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export async function checkRegistration(
  client: TrueForge,
  options: RegistrationOptions = {},
): Promise<RegistrationCheck> {
  const trustedSkill = inspectTrustedSkillPin(options);
  const [agents, skills, mcpServers, sandboxProvider] = await Promise.all([
    safely(() => client.agents.list()),
    safely(() => client.settings.skills.list()),
    safely(() => client.settings.mcpServers.list()),
    safely(() => client.settings.sandboxProviders.get()),
  ]);
  const github = mcpServers?.data.find((server) => server.name === "github");
  const githubAuthorized =
    github?.authStatus.status === "authenticated" || github?.authStatus.status === "not_required";
  const daytona = inspectDaytonaProvider(sandboxProvider?.data);

  return {
    trueforge: { reachable: agents !== null || skills !== null || mcpServers !== null },
    githubMcp: {
      configured: github !== undefined,
      authorized: githubAuthorized,
      ready: github !== undefined && githubAuthorized,
    },
    daytona,
    openquest: {
      skillRegistered: skills?.data.some((skill) => skill.name === "openquest") ?? false,
      agentRegistered: agents?.data.some((agent) => agent.name === "openquest") ?? false,
    },
    trustedSkill,
  };
}

export async function registerOpenQuest(
  client: TrueForge,
  manifest: TrueForgeApi.AgentSpec,
  options: RegistrationOptions = {},
): Promise<RegistrationResult> {
  const skillManifest = createTrustedSkillManifest(options);
  const inventory = await readRegistrationInventory(client);
  const matchingAgents = inventory.agents.filter((agent) => agent.name === "openquest");
  const matchingSkills = inventory.skills.filter((skill) => skill.name === "openquest");
  if (matchingAgents.length > 1) {
    throw new Error("OpenQuest agent registration is ambiguous");
  }
  if (matchingSkills.length > 1) {
    throw new Error("OpenQuest skill registration is ambiguous");
  }

  const existingAgent = matchingAgents[0];
  const existingSkill = matchingSkills[0];
  if (existingAgent !== undefined && !configuredAgentSchema.safeParse(existingAgent).success) {
    throw new Error("Existing OpenQuest agent manifest is invalid");
  }
  const parsedExistingSkill =
    existingSkill === undefined ? undefined : configuredSkillSchema.safeParse(existingSkill);
  if (parsedExistingSkill !== undefined && !parsedExistingSkill.success) {
    throw new Error("Existing OpenQuest skill manifest is invalid");
  }

  const readiness = registrationCheckFromInventory(inventory, options);
  if (!readiness.trueforge.reachable || !readiness.githubMcp.ready || !readiness.daytona.ready) {
    throw new Error("TrueForge, GitHub MCP, and Daytona must be ready before registration");
  }
  if (!readiness.trustedSkill.ready) {
    throw new Error("OpenQuest trusted skill pin is not ready");
  }

  const previousSkillManifest =
    parsedExistingSkill?.success === true
      ? (structuredClone(parsedExistingSkill.data.manifest) as TrueForgeApi.SkillManifest)
      : undefined;
  try {
    await client.settings.skills.createOrUpdate({ manifest: skillManifest });
  } catch {
    throw new Error("OpenQuest skill registration failed");
  }

  try {
    if (existingAgent === undefined) {
      await client.agents.create({ name: "openquest", manifest });
      return { skill: "created-or-replaced", agent: "created" };
    }
    await client.agents.update(existingAgent.id, { manifest });
    return { skill: "created-or-replaced", agent: "replaced" };
  } catch {
    if (previousSkillManifest === undefined) {
      throw new Error("OpenQuest agent registration failed; an unreferenced skill may remain");
    }
    try {
      await client.settings.skills.createOrUpdate({ manifest: previousSkillManifest });
    } catch {
      throw new Error("OpenQuest registration failed and previous skill restoration failed");
    }
    throw new Error("OpenQuest registration failed; previous skill restored");
  }
}

interface RegistrationInventory {
  agents: readonly TrueForgeApi.Agent[];
  skills: readonly TrueForgeApi.ConfiguredSkill[];
  mcpServers: readonly TrueForgeApi.ConfiguredMcpServer[];
  sandboxProvider: TrueForgeApi.ConfiguredSandboxProvider;
}

async function readRegistrationInventory(client: TrueForge): Promise<RegistrationInventory> {
  try {
    const [agents, skills, mcpServers, sandboxProvider] = await Promise.all([
      client.agents.list(),
      client.settings.skills.list(),
      client.settings.mcpServers.list(),
      client.settings.sandboxProviders.get(),
    ]);
    return {
      agents: agents.data,
      skills: skills.data,
      mcpServers: mcpServers.data,
      sandboxProvider: sandboxProvider.data,
    };
  } catch {
    throw new Error("OpenQuest registration preflight failed");
  }
}

function registrationCheckFromInventory(
  inventory: RegistrationInventory,
  options: RegistrationOptions,
): RegistrationCheck {
  const github = inventory.mcpServers.find((server) => server.name === "github");
  const githubAuthorized =
    github?.authStatus.status === "authenticated" || github?.authStatus.status === "not_required";
  return {
    trueforge: { reachable: true },
    githubMcp: {
      configured: github !== undefined,
      authorized: githubAuthorized,
      ready: github !== undefined && githubAuthorized,
    },
    daytona: inspectDaytonaProvider(inventory.sandboxProvider),
    openquest: {
      skillRegistered: inventory.skills.some((skill) => skill.name === "openquest"),
      agentRegistered: inventory.agents.some((agent) => agent.name === "openquest"),
    },
    trustedSkill: inspectTrustedSkillPin(options),
  };
}

type SandboxProviderLike = Pick<TrueForgeApi.ConfiguredSandboxProvider, "status"> & {
  manifest: { type: string };
};

function inspectDaytonaProvider(
  provider: SandboxProviderLike | null | undefined,
): RegistrationCheck["daytona"] {
  const status = provider?.status ?? "unknown";
  const configured = provider?.manifest.type === "daytona";
  return { configured, status, ready: configured && status === "ready" };
}

function inspectTrustedSkillPin(options: RegistrationOptions): RegistrationCheck["trustedSkill"] {
  const url = options.skillUrl ?? trustedSkillUrl;
  const urlAllowed = url === trustedSkillUrl;
  const immutableRef =
    options.skillRef !== undefined && immutableCommitPattern.test(options.skillRef);
  return { urlAllowed, immutableRef, ready: urlAllowed && immutableRef };
}

function createTrustedSkillManifest(options: RegistrationOptions): TrueForgeApi.SkillManifest {
  const trustedSkill = inspectTrustedSkillPin(options);
  if (!trustedSkill.ready || options.skillRef === undefined) {
    throw new Error("OpenQuest trusted skill pin is not ready");
  }
  return {
    name: "openquest",
    description:
      "Run a source-linked, sandbox-isolated open-source contribution campaign with approval-gated GitHub writes.",
    type: "git",
    url: trustedSkillUrl,
    ref: options.skillRef.toLowerCase(),
    path: "skills/openquest",
  };
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
  const registrationOptions: RegistrationOptions = {
    ...(process.env.OPENQUEST_SKILL_GIT_URL === undefined
      ? {}
      : { skillUrl: process.env.OPENQUEST_SKILL_GIT_URL }),
    ...(process.env.OPENQUEST_SKILL_GIT_REF === undefined
      ? {}
      : { skillRef: process.env.OPENQUEST_SKILL_GIT_REF }),
  };

  if (process.argv.includes("--check")) {
    console.log(JSON.stringify(await checkRegistration(client, registrationOptions), null, 2));
    return;
  }

  const result = await registerOpenQuest(client, await loadAgentManifest(), registrationOptions);
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(() => {
    console.error("OpenQuest registration failed; run with --check for readiness details");
    process.exitCode = 1;
  });
}
