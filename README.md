# OpenQuest

OpenQuest is a human-in-the-loop agent harness for responsible open-source contribution campaigns. A user chooses an open-source space, reviews evidence-ranked public repositories and issues, and creates one durable campaign per issue. TrueForge coordinates isolated work; SQLite preserves campaign facts; and exact, single-use approvals protect external actions.

This repository is an honest MVP, not an unattended pull-request bot. The current production composition supports live GitHub discovery through TrueForge, campaign creation, static preflight, implementation and verification child sessions, durable timelines, and approval issuance. GitHub writes are not exposed by an HTTP route. See [Current limitations](#current-limitations).

## Prerequisites

- Node.js 22 or newer and npm
- A local TrueForge service (the default URL is `http://127.0.0.1:8790`)
- A TrueForge-supported model configured outside this repository
- A GitHub MCP server configured and authorized in TrueForge
- A ready Daytona sandbox provider in TrueForge
- An immutable, pushed commit containing `skills/openquest/SKILL.md`

Credentials belong in provider credential stores or the current shell, never in committed files, screenshots, evidence, command output, URLs, or sandbox artifacts.

## Install and configure

Install exactly the locked dependency graph:

```sh
npm ci
```

Optional server settings are `PORT` (default `8788`), `DATABASE_PATH` (default `openquest.sqlite`), and `TRUEFORGE_BASE_URL` (default `http://localhost:8790`). The single-operator browser experience starts directly with project discovery; it does not require a browser credential.

Register the trusted OpenQuest skill and agent only after GitHub MCP and Daytona are ready. The skill ref must be a full immutable commit SHA available from the allowlisted repository:

```sh
export OPENQUEST_SKILL_GIT_REF="$(git rev-parse HEAD)"
npm exec -- tsx scripts/register-openquest-agent.ts --check
npm exec -- tsx scripts/register-openquest-agent.ts
```

The registration command uses TrueForge inventory and settings APIs. It does not configure provider credentials. `TRUEFORGE_URL` and optional `TRUEFORGE_TOKEN` configure this registration client; they are separate from the server's `TRUEFORGE_BASE_URL` setting.

## Run locally

Start TrueForge, the API, and the web application together:

```sh
npm run dev
```

Open `http://127.0.0.1:5173/`. The API listens on `http://127.0.0.1:8788/`; TrueForge normally listens on `http://127.0.0.1:8790/`.

The UI starts directly with discovery. GitHub access in the embedded OpenQuest chat is read-only: the agent manifest enables only `@read-only` GitHub MCP tools. The campaign approval button issues time-limited authority for one exact server-owned proposal; it does not execute that action or write to GitHub.

## Repeatable demo preflight

Run the non-secret, read-only preflight before a demo:

```sh
npm exec -- tsx scripts/demo.ts
```

It reports the web and API ports, liveness/readiness, TrueForge reachability, GitHub MCP authorization, Daytona state, agent and skill registration, trusted skill pin, and the exact browser URL. It performs HTTP `GET` requests and TrueForge inventory reads only. It does not create a campaign, run a sandbox, or call a GitHub write tool.

Use `--strict` when the command should exit non-zero unless every reported dependency is ready:

```sh
npm exec -- tsx scripts/demo.ts --strict
```

OpenQuest currently has no runtime fixture mode. `fixtures/` supports existing automated tests; it is never silently substituted for live GitHub, TrueForge, or Daytona evidence. Full presentation steps and evidence checkpoints are in [docs/demo-script.md](docs/demo-script.md).

## Campaign flow

1. Choose one or more curated spaces.
2. TrueForge uses GitHub read tools to return source-linked public repository and issue evidence.
3. Starting an issue creates a SQLite campaign and one parent TrueForge session in `policy_review`.
4. Each `preflight`, `implement`, or `verify` operation creates a fresh child session. The OpenQuest agent configuration gives that session a Daytona sandbox.
5. Static preflight must return all five required checks, a commit SHA, and proof that dependencies and repository scripts were not executed. Invalid or uncertain output quarantines the campaign.
6. Durable evidence, child/sandbox references, campaign events, approvals, commits, and escalation reasons remain isolated by campaign.
7. A valid external-action proposal may be approved only for its exact payload digest and current campaign version. Approval expires after ten minutes and is single-use.
8. After a real pull request exists, OpenQuest leaves maintainer review and merge decisions to people. Qodo is not part of this workflow.

The HTTP action routes currently cover `preflight`, `implement`, and `verify`; the product UI displays the parent TrueForge session and durable record. This single-operator deployment does not require a browser bearer token. Every external write still requires a fresh, exact in-product approval and this release does not wire an execution adapter.

## Health and readiness

- `GET /api/healthz` answers `ok` when the process is live.
- `GET /api/readyz` answers `ready` when the process is ready to serve OpenQuest. It has no Qodo dependency.

## Verification

CI and local release verification use the existing project commands:

```sh
npm run typecheck
npm run lint
npm run build
npm test
```

The repository also defines targeted integration and Playwright commands, but Task 11 does not add or alter tests. The quality workflow installs with `npm ci` and runs type-check, lint, build, and the existing test suite on pushes and pull requests with read-only repository permissions.

## Qodo code review for this repository

Qodo is retained for the Agent Harness repository's own PR review practice. It is not invoked by, configured for, or a dependency of an OpenQuest campaign.

[PR #3: Fix TrueForge discovery stream hangs](https://github.com/mohantyabhijit/agent-harness/pull/3) is the representative merged implementation PR. Qodo raised a cleanup-timeout reliability bug, the branch added an abort-on-cleanup repair, and the final commit received a follow-up Qodo update before merge. The [pull-request template](.github/pull_request_template.md) makes the same evidence and decision trail required for future changes.

## Repository map

```text
config/agents/       trusted TrueForge agent manifest
skills/openquest/    contribution safety and execution skill
src/domain/          campaign, approval, discovery, and quality rules
src/application/     use cases and provider ports
src/adapters/        SQLite, TrueForge, GitHub-catalog, and Qodo adapters
src/server/          Fastify composition, routes, auth, and review scheduler
src/web/             React campaign experience and embedded TrueForge UI
scripts/             registration and read-only demo preflight
docs/                architecture, threat model, Qodo, and demo guidance
evidence/            non-secret evidence contract and capture checklist
```

## Current limitations

- There is no fixture-backed application or `OPENQUEST_DEMO_MODE`; fixtures are test-only.
- No server route or production adapter executes approved GitHub comments, assignment requests, branch pushes, pull-request creation, or pull-request updates. Approval issuance alone causes no external write.
- The browser has no controls for the API's `preflight`, `implement`, and `verify` action routes; those operations currently require an authenticated API client.
- The chat surface uses the parent TrueForge session but enables only GitHub read tools. It cannot publish contributions.
- The SQLite store is local-process persistence. There is no multi-user identity model, distributed scheduler, backup workflow, or hosted deployment configuration.
- Sandbox isolation and lifecycle enforcement depend on the configured TrueForge/Daytona provider. Static preflight reduces risk but cannot prove arbitrary code safe or substitute for sandbox controls.

Architecture and trust boundaries are detailed in [docs/architecture.md](docs/architecture.md) and [docs/threat-model.md](docs/threat-model.md). Qodo-specific behavior is documented in [docs/qodo-workflow.md](docs/qodo-workflow.md).
