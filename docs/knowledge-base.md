# OpenQuest knowledge base

Updated 2026-08-28. This is a repository-owned record of implementation facts and reproducible verification evidence. It is not a claim that external provider credentials or maintainer approval are available.

## Product boundary

OpenQuest is the contribution-campaign surface for Agent Harness. It helps a contributor move from repository discovery to a policy-aware, sandboxed, reviewable pull request proposal. GitHub, TrueForge, Daytona, and Qodo are injected ports; domain rules remain testable without live services.

The safety boundary is deliberate: repository text and tool output are untrusted evidence; consequential GitHub actions are approval-gated; approvals are exact-payload, version-, digest-, and idempotency-bound; Qodo repair is capped at three iterations.

## What is implemented

- Domain rules for repository ranking, issue lanes, campaign transitions, evidence completeness, approval validity, and Qodo quality gates.
- SQLite-backed campaign persistence, migrations, leases, restart recovery, sanitized public projections, and optimistic version fencing.
- Fastify routes for spaces, discovery, campaigns, approval proposals, approval issuance, support/readiness, and authenticated review synchronization.
- TrueForge-facing adapters and explicit unavailable-provider behavior for Qodo when no authenticated authority is configured.
- React onboarding, discovery, campaign timeline, evidence, quality-gate, change-brief, and approval surfaces.
- Fixture-friendly component and API tests plus browser coverage for onboarding-to-discovery.
- UI polish pass retaining the graphite/purple/lime visual language, with provenance labeling, visible focus treatment, reduced-motion handling, responsive grids, and actionable issue controls.

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

Current evidence from the latest independent pass: 416 unit tests and 127 integration tests pass; typecheck, lint, and build pass. Browser coverage was previously absent and is now represented by `tests/e2e/onboarding.spec.ts`; rerun the command after every UI change. The dependency audit reported two low and one moderate transitive advisory in the inspected worktree and remains a release follow-up.

## External MR/PR status

No pull request was created against FastAPI. The connected GitHub integration can read public PR history and identify the authenticated account, but it returned HTTP 403 when checking collaborator permission and has no available fork/branch creation path for that third-party repository. Do not represent a candidate as raised until a real branch, commit, CI result, and public PR URL exist. The current repository branch is the reviewable implementation artifact; external publication requires an authenticated fork or maintainer-approved branch.

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
