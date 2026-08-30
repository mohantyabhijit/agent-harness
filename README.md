# OpenQuest

OpenQuest is a human-in-the-loop agent harness for responsible open-source contribution campaigns. A user chooses an open-source space, reviews evidence-ranked public repositories and issues, and creates one durable campaign per issue. TrueForge coordinates isolated work; SQLite preserves campaign facts; exact, single-use approvals protect external actions; and a bounded Qodo gate can request at most three repair iterations.

This repository is an honest MVP, not an unattended pull-request bot. It supports live GitHub discovery through TrueForge, durable campaign planning, isolated implementation and verification, exact branch/PR proposals, separate approvals and publication calls, and a bounded Qodo repair gate. The default local composition deliberately injects neither a live GitHub publisher nor Qodo/repair authority; those provider seams fail closed. See [Current limitations](#current-limitations).

## Prerequisites

- Node.js 22 or newer and npm
- A local TrueForge service (the default URL is `http://127.0.0.1:8790`)
- A TrueForge-supported model configured outside this repository
- A GitHub MCP server configured and authorized in TrueForge
- A ready Daytona sandbox provider in TrueForge
- An immutable, pushed commit containing `skills/openquest/SKILL.md`
- For Qodo readiness, an authenticated review authority and independent repair verifier implementation; these are not included in the default container

Credentials belong in provider credential stores or the current shell, never in committed files, screenshots, evidence, command output, URLs, or sandbox artifacts.

## Install and configure

Install exactly the locked dependency graph:

```sh
npm ci
```

Create two distinct, high-entropy capability tokens in your shell. Do not paste their values into documentation or evidence:

```sh
export OPERATOR_BEARER_TOKEN="$(openssl rand -hex 32)"
export REVIEW_PROVIDER_BEARER_TOKEN="$(openssl rand -hex 32)"
export QODO_BOT_IDENTITIES="the-verified-qodo-bot-login[bot]"
```

Optional server settings are `PORT` (default `8788`), `DATABASE_PATH` (default `openquest.sqlite`), `TRUEFORGE_BASE_URL` (default `http://localhost:8790`), `QODO_POLL_INTERVAL_MS` (default `60000`), and `QODO_SHUTDOWN_TIMEOUT_MS` (default `5000`). The browser stores the operator capability only in React memory: reload, close, or **Disconnect** clears it. It is never persisted to local or session storage.

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

The UI asks for the operator capability before authenticated discovery. The onboarding conversation maps a user's interest to one of the five structured categories; repository results still come only from the verified discovery pipeline. GitHub access in the embedded campaign chat is read-only: the agent manifest enables only `@read-only` GitHub MCP tools. The campaign approval button issues time-limited authority for one exact server-owned proposal. A separate execution control appears only while that exact approval remains active. In the default local composition publication is unavailable because no live publisher is injected.

## Repeatable demo preflight

Run the non-secret, read-only preflight before a demo:

```sh
npm exec -- tsx scripts/demo.ts
```

It reports the web and API ports, liveness/readiness, TrueForge reachability, GitHub MCP authorization, Daytona state, agent and skill registration, trusted skill pin, Qodo readiness, and the exact browser URL. It performs HTTP `GET` requests and TrueForge inventory reads only. It does not create a campaign, run a sandbox, or call a GitHub write tool. Missing TrueForge or Qodo providers are reported as unavailable instead of being represented as passing.

Use `--strict` when the command should exit non-zero unless every reported dependency is ready:

```sh
npm exec -- tsx scripts/demo.ts --strict
```

OpenQuest currently has no runtime fixture mode. `fixtures/` supports existing automated tests; it is never silently substituted for live GitHub, TrueForge, Daytona, or Qodo evidence. Full presentation steps and evidence checkpoints are in [docs/demo-script.md](docs/demo-script.md).

## Campaign flow

1. Describe a contribution interest in the embedded TrueForge chat, then choose one of five structured categories: AI & agents, Developer tools, Web & apps, Data & infrastructure, or Civic, science & social impact. The chat clarifies intent; authoritative repository results appear only in the validated discovery cards.
2. TrueForge uses GitHub read tools live to return at most eight source-linked public repository recommendations ranked by popularity plus contribution readiness.
3. Starting an issue creates one parent TrueForge session, runs a bounded read-only policy child to produce a strict source-backed issue brief, and persists the campaign and brief atomically in `policy_review`.
4. The parent session remains available for discussion. The user must explicitly finalize the persisted brief before static preflight, cloning, or sandbox execution becomes available; duplicate and stale finalization requests fail closed.
5. Each `preflight`, `implement`, or `verify` operation creates a fresh child session. The OpenQuest agent configuration gives that session a Daytona sandbox.
6. Static preflight must return all five required checks, a commit SHA, and proof that dependencies and repository scripts were not executed. Invalid or uncertain output quarantines the campaign.
7. Durable evidence, child/sandbox references, campaign events, approvals, commits, Qodo findings, and escalation reasons remain isolated by campaign.
8. After implementation, the campaign shows a commit-bound before/after explanation, changed areas, executed tests, and remaining uncertainty beside the resumable parent chat.
9. A valid external-action proposal may be approved only for its exact payload digest and current campaign version. Approval expires after ten minutes and is single-use.
10. Successful verification atomically advances to contribution approval and creates the exact branch-push proposal. A completed branch push atomically creates a separate pull-request proposal; approval and execution remain separate at both stages.
11. After a real pull request exists, authenticated Qodo evidence may pass the gate, request a fresh isolated repair, or escalate. There is no fourth automatic repair iteration.

Repository names retained from prior Exa-assisted research are search seeds only. They do not carry verified current stars or contribution readiness, do not guarantee display, and do not replace canonical GitHub checks for visibility, license, activity, contribution policy, and accepted external pull requests. The runtime has no Exa dependency. `openai/codex` is excluded from code-PR recommendations because its official policy rejects external code contributions.

The HTTP action routes cover issue-brief finalization, `preflight`, `implement`, `verify`, exact approved publication, and unknown-outcome reconciliation; the product UI exposes only the next action allowed by durable state. API `POST` requests require the operator bearer capability except review synchronization, which requires the distinct review-provider capability. `GET` and `HEAD` routes return sanitized, read-only projections without a bearer token.

## Health and readiness

- `GET /api/healthz` always answers as a liveness endpoint and reports either `ok` or sanitized review degradation.
- `GET /api/readyz` returns `200` only when the configured review job is ready. It returns `503 not_ready` when authenticated Qodo review resolution, repair verification, the scheduler, or recent store health is unavailable.

In the default container, readiness is expected to be `503`: `UnavailableQodoReviewAuthority` is injected and `repairVerifierReady` is false. That is an explicit release limitation, not a successful Qodo configuration.

## Verification

CI and local release verification use the existing project commands:

```sh
npm run typecheck
npm run lint
npm run build
npm test
```

The repository also defines targeted integration and Playwright commands. `npm run test:e2e` includes a controlled local contribution flow that exercises discovery through separate branch and pull-request approvals without contacting or mutating GitHub. The quality workflow installs with `npm ci` and runs type-check, lint, build, and the test suite on pushes and pull requests with read-only repository permissions.

## Qodo Code Review Evidence

Every repository change follows the [change checklist](TODO.md): a focused branch and PR, recorded verification, Qodo review of the latest commit, resolution or documented disposition of findings, a follow-up Qodo review after repairs, passing GitHub checks, and an authorized maintainer merge. Direct pushes to `main` do not count as reviewed work.

[PR #16: Conversation-first repository discovery](https://github.com/mohantyabhijit/agent-harness/pull/16) is the representative merged implementation PR. Qodo surfaced unvalidated chat recommendations, insufficient claim-specific repository evidence, ranking and conversation races, and transient-session lifecycle defects; the final code fixed those findings and received an [exact-head follow-up review](https://github.com/mohantyabhijit/agent-harness/pull/16#issuecomment-5468824110) before merge. One Medium observability recommendation was [intentionally deferred with its reason recorded in the Qodo thread](https://github.com/mohantyabhijit/agent-harness/pull/16#discussion_r3889579536): cleanup remains best-effort and outcome-preserving, while durable cleanup metrics wait for a repository-wide telemetry sink rather than ad-hoc console logging. The [pull-request template](.github/pull_request_template.md) makes the same evidence and decision trail required for future changes.

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
- The default Qodo review authority is unavailable, no production repair verifier is injected, and readiness therefore fails closed.
- The server publisher route supports only exact approved branch pushes and pull-request creation, but the default local container injects no live GitHub publisher. Comments, assignment, and PR updates have no production publisher route. Approval issuance alone causes no external write.
- The chat surface uses the parent TrueForge session but enables only GitHub read tools. Publication remains a separate server-only capability. A chat rendering failure is contained so durable campaign controls remain usable.
- The SQLite store is local-process persistence. There is no multi-user identity model, distributed scheduler, backup workflow, or hosted deployment configuration.
- Sandbox isolation and lifecycle enforcement depend on the configured TrueForge/Daytona provider. Static preflight reduces risk but cannot prove arbitrary code safe or substitute for sandbox controls.

Architecture and trust boundaries are detailed in [docs/architecture.md](docs/architecture.md) and [docs/threat-model.md](docs/threat-model.md). Qodo-specific behavior is documented in [docs/qodo-workflow.md](docs/qodo-workflow.md).
