# IncidentForge

IncidentForge is a human-in-the-loop production incident investigator built for the Agent Harness Hackathon. It uses TrueForge to collect operational evidence, delegate independent investigations, analyze data in a sandbox, preserve incident context, and stop for approval before any state-changing action.

The product scope and acceptance criteria live in [GitHub issue #1](https://github.com/mohantyabhijit/agent-harness/issues/1).

## Why this exists

Most AI incident tools explain what an engineer should inspect. IncidentForge is designed to perform the investigation: query connected systems, test hypotheses, assemble an evidence timeline, and propose a defensible next action while keeping an engineer in control.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- API credentials for a model provider supported by TrueForge
- Optional: MCP integrations for GitHub and observability data
- Optional: a Daytona account for sandboxed execution

The repository pins TrueForge to the version recorded in `package-lock.json` so every contributor starts from the same runtime.

## Start locally

```bash
npm ci
npm run dev
```

Open [http://localhost:8790](http://localhost:8790).

TrueForge local mode runs as a single process backed by SQLite. Keep it bound to localhost; it is intended for personal development, not direct internet exposure.

## Configure TrueForge

In the TrueForge UI:

1. Open **Settings → Models** and add a model provider.
2. Open **Settings → Connectors** and add only the MCP servers needed for the current demo.
3. Open **Settings → Skills** and import [`skills/incident-forge/SKILL.md`](skills/incident-forge/SKILL.md) from this repository.
4. Open **Settings → Sandbox providers** and add Daytona if sandboxed analysis is required.
5. In chat, enable the connectors, IncidentForge skill, dynamic subagents, and sandbox.
6. Save the working configuration as a reusable agent named **IncidentForge**.

Never commit provider tokens or connector credentials. Enter them through the relevant provider UI.

## Initial demo target

The first vertical slice will ingest a synthetic failed-deployment incident, delegate repository and telemetry investigation to focused subagents, parse evidence in a Daytona sandbox, and produce a sourced incident report. A remediation proposal must remain blocked until the user explicitly approves it.

## Repository map

```text
.
├── docs/architecture.md
├── skills/incident-forge/SKILL.md
├── package.json
└── package-lock.json
```

## Development workflow

Work in focused pull requests and run each through Qodo, as required by the hackathon guide. Treat review findings as evidence: address meaningful issues and record the resulting changes in the pull request.

## Source guide

This setup follows the [Agent Harness Hackathon getting-started guide](https://www.wemakedevs.org/blogs/agent-harness-hackathon-kick-off), published August 24, 2026.
