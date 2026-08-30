# OpenQuest knowledge base

Updated 2026-08-30. This is a repository-owned record of implementation facts and reproducible verification evidence. It is not a claim that external provider credentials or maintainer approval are available.

## Repository audit baseline

The feature audit covers the complete `main` history through `4191fc2`, including the merged OpenQuest implementation branch and the later deployment, Qodo automation, TrueForge stream-cleanup, and authentication-classification commits. The current, commit-backed catalog is [FEATURES.md](../FEATURES.md). It distinguishes shipped code from external-provider readiness, unimplemented GitHub writes, and superseded bootstrap work.

## Change and review operating rule

Every repository change must be reflected in the root [TODO.md](../TODO.md) checklist and its pull-request evidence: focused branch and issue when applicable, clear scope and rationale, executed verification, Qodo review of the final commit, documented findings/dispositions, required checks, and an authorized maintainer merge. The maintainer may be a human or an agent explicitly authorized by the user for that merge. The public README links the representative Qodo-reviewed implementation PR; local checks or a local Qodo client are not substitutes for that GitHub evidence. Documentation-only changes still update the checklist and verification record; the scope of the checks may be proportionate to the change.

## Product boundary

OpenQuest is the contribution-campaign surface for Agent Harness. It helps a contributor move from repository discovery to a policy-aware, sandboxed, reviewable pull request proposal. GitHub, TrueForge, Daytona, and Qodo are injected ports; domain rules remain testable without live services.

The safety boundary is deliberate: repository text and tool output are untrusted evidence; consequential GitHub actions are approval-gated; approvals are exact-payload, version-, digest-, and idempotency-bound; Qodo repair is capped at three iterations.

## What is implemented

- Conversation-first repository discovery through the embedded TrueForge chat, plus five one-click category choices: AI & agents, Developer tools, Web & apps, Data & infrastructure, and Civic, science & social impact. Chat clarifies intent, but authoritative repository and issue recommendations appear only in the validated discovery cards.
- A deterministic top-eight recommendation boundary ranked by popularity plus contribution readiness, strict source-linked GitHub repository/issue validation, and Easy Win versus Long-Term Challenge issue lanes.
- Durable one-issue/one-campaign orchestration with a campaign state machine, resumable parent TrueForge sessions, fresh child sessions, Daytona sandbox requirements, static preflight, structured implementation, and structured verification.
- Backend-generated issue briefs from a bounded read-only TrueForge policy child. The strict problem/cause/smallest-fix/test/risk/uncertainty/evidence object is stored with campaign creation, projected through an allowlist, remains discussable in the parent chat, and must be explicitly finalized with campaign-version and idempotency fencing before preflight is exposed.
- SQLite-backed campaign persistence, migrations, ordered events, leases, optimistic version and identity fencing, restart recovery, external-action claims, outcome reconciliation, and sanitized public projections.
- Exact, server-owned approval proposals bound to payload digest, campaign/version/status, current commit, idempotency key, ten-minute expiry, and atomic single use.
- Authenticated Qodo locator resolution, strict finding normalization, allowlisted bot identities, an independent repair-verification port, a fail-closed quality gate, at most three repair iterations, and durable human escalation.
- Fastify routes for spaces, discovery, campaigns, issue-brief finalization, `preflight`/`implement`/`verify`, approval issuance, authenticated review synchronization, liveness, and readiness, protected by separate operator and review-provider capabilities.
- React onboarding, progressive discovery, source-backed issue-brief review/finalization, resumable campaign timeline, evidence, quality-gate, action controls for the next allowed preflight/implementation/verification step, change-brief, approval, and embedded TrueForge thread surfaces with stale-request and approval-race handling.
- Commit-pinned TrueForge skill/agent registration with dependency preflight and rollback, plus bounded stream cleanup and preservation of late authentication failures.
- `/openquest/` production hosting, same-origin embedded TrueForge proxying, Nginx and systemd configuration, read-only demo preflight, read-only CI, autonomous Qodo v2 PR review configuration, and layered automated tests.

The exhaustive descriptions and introducing/hardening commit references live in [FEATURES.md](../FEATURES.md). Historical IncidentForge and the temporary standalone demo are recorded there as superseded rather than current product features.

The discovery pipeline keeps Exa-assisted background candidates only as search leads. It does not run Exa at runtime and never treats a seed, old star count, or prior research result as current evidence. Every displayed repository must be freshly checked with GitHub read tools for public visibility, explicit licensing, recent activity, contribution guidance, and evidence of accepted external pull requests. `openai/codex` is excluded from code-PR recommendations because its contribution policy rejects external code contributions.

## Verified repository evidence

The product research fixture records a public FastAPI snapshot and two recent merged pull requests:

- [#16252](https://github.com/fastapi/fastapi/pull/16252), Typer minimum-version update, merged 2026-08-26.
- [#16249](https://github.com/fastapi/fastapi/pull/16249), `setup-uv` action update, merged 2026-08-25.

Older merged FastAPI examples were also inspected to understand maintainer-friendly contribution shape: focused bug fixes with regression tests, narrow documentation changes, and dependency/tooling maintenance. These are patterns for candidate generation, not permission to submit to FastAPI.

## Verification commands

Run from the repository root:

```bash
npm ci
npm test
npm run test:integration
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm audit --omit=dev
git diff --check
```

Current evidence from the 2026-08-30 repository audit: 418 tests in the full Vitest suite, 127 tests in the focused integration suite, and the onboarding/discovery Playwright test pass; typecheck, lint, and build pass. The dependency audit reported two low and one moderate transitive advisory in the previously inspected worktree and remains a release follow-up until `npm audit --omit=dev` is rerun.

## External MR/PR status

No pull request was created against FastAPI. The connected GitHub integration can read public PR history and identify the authenticated account, but it returned HTTP 403 when checking collaborator permission and has no available fork/branch creation path for that third-party repository. Do not represent a candidate as raised until a real branch, commit, CI result, and public PR URL exist. The current repository branch is the reviewable implementation artifact; external publication requires an authenticated fork or maintainer-approved branch.

## Local contribution-flow QA (2026-08-30)

The controlled local flow now covers category selection, verified repository and issue selection, durable brief finalization, static preflight, isolated implementation, verification, server-owned branch proposal, separate branch approval and execution, server-owned pull-request proposal, separate PR approval and execution, and final canonical reference reload. The fixture records the exact publication requests and performs no external network call or GitHub write.

The full local release matrix passed with 514 Vitest tests and three Playwright scenarios, plus typecheck, lint, production build, and diff checks. This is deterministic application evidence, not provider evidence. No live TrueForge model/Daytona execution, live GitHub publisher, Qodo runtime authority, deployment, or third-party open-source pull request was exercised. The controlled TrueForge chat fixture exposed an upstream UI runtime update-loop error; the campaign now contains that failure behind an error boundary so campaign facts and approvals remain usable, but a provider-backed chat turn remains a separate readiness check.

## Hosted deployment

The production target is the existing DigitalOcean VPS behind Nginx/TLS at `https://abhijitmohanty.com/openquest/`. Releases live under `/srv/openquest/releases/<commit>`, with `current` updated atomically. The static Vite bundle is served by Nginx; `/openquest/api/` proxies to the localhost OpenQuest API on port 8788; `/openquest/trueforge/` proxies to the standalone TrueForge service on port 8790. Service definitions are in `deploy/`.

The hosted API uses a private `/etc/openquest.env` generated on the VPS and never committed. TrueForge and Qodo/GitHub provider readiness must be checked independently; a reachable page is not evidence that provider-backed discovery or Qodo review is configured.

### Hosted runtime verification (2026-08-28)

The deployed release is `a55cab555ee4cb9798a9e30f122072a7fe8b9c7a`. Both `openquest-api.service` and `openquest-trueforge.service` are active, the public UI returns HTTP 200, and unauthenticated API writes correctly return HTTP 401. The release also preserves the dedicated authentication error for late TrueForge MCP-auth events. The VPS TrueForge instance is reachable and its read-only GitHub MCP is authenticated; the OpenQuest skill URL and immutable release ref are valid.

The deployment is not provider-ready for discovery yet: the remote TrueForge tenant has no Daytona sandbox provider, no sandbox API key is available on the host, and therefore no `openquest` agent is registered there. `/openquest/api/healthz` reports `provider_unavailable` and `/openquest/api/readyz` intentionally returns HTTP 503. Configure the Daytona provider through TrueForge settings using a secret-managed API key, then run the following pinned, secret-free checks before enabling traffic:

```sh
export TRUEFORGE_URL=http://[::1]:8790
export OPENQUEST_SKILL_GIT_URL=https://github.com/mohantyabhijit/agent-harness.git
export OPENQUEST_SKILL_GIT_REF=a55cab555ee4cb9798a9e30f122072a7fe8b9c7a
npx tsx scripts/register-openquest-agent.ts --check
npx tsx scripts/register-openquest-agent.ts
```
