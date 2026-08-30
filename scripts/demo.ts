import { TrueForge } from "@truefoundry/trueforge-sdk";

import { checkRegistration } from "./register-openquest-agent.js";

type ProbeState = "ready" | "not-ready" | "unavailable";

interface HttpProbe {
  readonly state: ProbeState;
  readonly statusCode?: number;
  readonly serviceStatus?: string;
  readonly reviewCode?: string;
}

const timeoutMs = 3_000;

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const webUrl = configuredUrl("OPENQUEST_WEB_URL", "http://127.0.0.1:5173/");
  const apiUrl = configuredUrl("OPENQUEST_API_URL", "http://127.0.0.1:8788/");
  const trueForgeUrl = configuredUrl("TRUEFORGE_URL", "http://127.0.0.1:8790/");
  const token = process.env.TRUEFORGE_TOKEN;
  const client = new TrueForge({
    baseUrl: trueForgeUrl.href.replace(/\/$/u, ""),
    ...(token === undefined || token.length === 0 ? {} : { token }),
    logging: { silent: true },
    timeoutInSeconds: timeoutMs / 1_000,
    maxRetries: 0,
  });

  const [web, health, readiness, registration] = await Promise.all([
    probe(new URL(webUrl.pathname, webUrl.origin)),
    probe(new URL("/api/healthz", apiUrl)),
    probe(new URL("/api/readyz", apiUrl), true),
    checkRegistration(client, {
      ...(process.env.OPENQUEST_SKILL_GIT_URL === undefined
        ? {}
        : { skillUrl: process.env.OPENQUEST_SKILL_GIT_URL }),
      ...(process.env.OPENQUEST_SKILL_GIT_REF === undefined
        ? {}
        : { skillRef: process.env.OPENQUEST_SKILL_GIT_REF }),
    }),
  ]);

  console.log("OpenQuest demo preflight (read-only)");
  console.log("Mode: live providers only; repository fixtures are test data and are not injected into the application.");
  if (process.env.OPENQUEST_DEMO_MODE !== undefined) {
    console.log("[info] OPENQUEST_DEMO_MODE is not implemented and has no effect.");
  }
  report("Web UI", web.state, web.statusCode === undefined ? undefined : `HTTP ${String(web.statusCode)}`);
  report("API liveness", health.state, probeDetail(health));
  report("API readiness / Qodo", readiness.state, probeDetail(readiness));
  report("TrueForge", registration.trueforge.reachable ? "ready" : "unavailable");
  report("GitHub MCP read access", registration.githubMcp.ready ? "ready" : "not-ready", registration.githubMcp.configured ? (registration.githubMcp.authorized ? "configured and authorized" : "configured; authorization required") : "not configured");
  report("Daytona sandbox provider", registration.daytona.ready ? "ready" : "not-ready", registration.daytona.configured ? `status ${registration.daytona.status}` : "not configured");
  report("OpenQuest skill", registration.openquest.skillRegistered ? "ready" : "not-ready", registration.openquest.skillRegistered ? "registered" : "not registered");
  report("OpenQuest agent", registration.openquest.agentRegistered ? "ready" : "not-ready", registration.openquest.agentRegistered ? "registered" : "not registered");
  report("Trusted skill pin", registration.trustedSkill.ready ? "ready" : "not-ready", trustedSkillDetail(registration.trustedSkill));
  console.log(`Browser URL: ${webUrl.href}`);
  console.log("This command performs HTTP GETs and TrueForge inventory reads only. It does not call GitHub write tools.");

  const allReady = web.state === "ready" && health.state === "ready" && readiness.state === "ready" &&
    registration.trueforge.reachable && registration.githubMcp.ready && registration.daytona.ready &&
    registration.openquest.skillRegistered && registration.openquest.agentRegistered && registration.trustedSkill.ready;
  if (strict && !allReady) process.exitCode = 1;
}

async function probe(url: URL, requireReadyStatus = false): Promise<HttpProbe> {
  const controller = new AbortController();
  const deadline = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json, text/html;q=0.9" },
      redirect: "error",
      signal: controller.signal,
    });
    const payload = await safePayload(response);
    return {
      state: response.ok && (!requireReadyStatus || (payload.status !== "not_ready" && payload.status !== "degraded")) ? "ready" : "not-ready",
      statusCode: response.status,
      ...(payload.status === undefined ? {} : { serviceStatus: payload.status }),
      ...(payload.reviewCode === undefined ? {} : { reviewCode: payload.reviewCode }),
    };
  } catch {
    return { state: "unavailable" };
  } finally {
    clearTimeout(deadline);
  }
}

async function safePayload(response: Response): Promise<{ status?: string; reviewCode?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const status = safeLabel(record.status);
    const review = typeof record.review === "object" && record.review !== null && !Array.isArray(record.review)
      ? record.review as Record<string, unknown>
      : undefined;
    const reviewCode = safeLabel(review?.code);
    return {
      ...(status === undefined ? {} : { status }),
      ...(reviewCode === undefined ? {} : { reviewCode }),
    };
  } catch {
    return {};
  }
}

function configuredUrl(name: string, fallback: string): URL {
  const url = new URL(process.env[name] ?? fallback);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error(`${name} must be a non-credentialed HTTP(S) URL`);
  }
  return url;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : undefined;
}

function report(label: string, state: ProbeState, detail?: string): void {
  console.log(`[${state}] ${label}${detail === undefined ? "" : `: ${detail}`}`);
}

function probeDetail(probeResult: HttpProbe): string | undefined {
  const details = [
    probeResult.statusCode === undefined ? undefined : `HTTP ${String(probeResult.statusCode)}`,
    probeResult.serviceStatus,
    probeResult.reviewCode,
  ].filter((value): value is string => value !== undefined);
  return details.length === 0 ? undefined : details.join(", ");
}

function trustedSkillDetail(skill: Awaited<ReturnType<typeof checkRegistration>>["trustedSkill"]): string {
  if (!skill.urlAllowed) return "Git URL is not allowlisted";
  if (!skill.immutableRef) return "set OPENQUEST_SKILL_GIT_REF to a 40-character commit SHA";
  return "allowlisted URL and immutable commit";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "invalid local configuration";
  console.error(`OpenQuest demo preflight could not run: ${message}`);
  process.exitCode = 1;
});
