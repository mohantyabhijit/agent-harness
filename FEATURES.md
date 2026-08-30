# OpenQuest features

This catalog describes the features present on `main` at commit `4191fc2` after reviewing the repository history and current source. Commit references identify the changes that introduced each capability; later hardening commits are grouped with the feature they protect.

OpenQuest is an approval-gated, evidence-first harness for open-source contribution campaigns. It is not an autonomous GitHub write bot. Features that depend on external providers are implemented as fail-closed integration seams and are usable only when those providers are configured and ready.

## Discovery and campaign selection

- **Nine curated contribution spaces.** Contributors can select AI/ML, developer tools, web, mobile, data, infrastructure, security, science, and social impact. (`200aab6`, `9ff9269`)
- **Evidence-ranked repositories.** OpenQuest scores public repositories using popularity, recent activity, contribution guidance, CI health, external pull-request acceptance, topic match, and maintainer responsiveness. The score explanation retains each weighted input, source URL, and retrieval time. (`200aab6`, `fc60386`)
- **Fail-closed live GitHub discovery.** TrueForge returns strictly validated repository and issue envelopes. OpenQuest rejects private repositories, missing or invalid evidence, canonical-identity mismatches, cross-repository issue URLs, duplicates, and malformed provider output instead of silently substituting fixtures. (`200aab6`, `4a7453d`, `e470867`, `d1b0c14`)
- **Issue lanes.** Issues are classified as **Easy Wins** or **Long-Term Challenges** from scope clarity, affected areas, test complexity, dependency risk, and estimated effort. (`200aab6`)
- **Progressive and recoverable discovery UI.** Repository results render before every issue request completes; individual issue loads can be retried, stale responses are fenced, duplicate repositories are removed, and unmounted requests are cancelled. (`9ff9269`, `62118f6`, `aab306f`, `daf1505`, `ce0e93b`, `341ed22`)
- **One campaign per public issue.** Campaign creation enforces a unique repository/issue pair and rejects duplicate attempts, preventing parallel durable records for the same issue. (`b0b4322`, `8d174a3`)

## Campaign orchestration and isolation

- **Explicit campaign state machine.** Campaigns move through policy review, coordination, preflight, quarantine, baseline, implementation, verification, contribution approval, pull-request review, repair, escalation, and terminal states only through allowed transitions. (`c4c2dfe`, `6849556`)
- **Parent and child TrueForge sessions.** Each campaign has a resumable parent session for context. Discovery, preflight, implementation, verification, Qodo synchronization, and repair use fresh child sessions with bounded goals and campaign-specific packets. (`e470867`, `8d174a3`, `01681b0`, `01c1485`)
- **Daytona-backed sandbox contract.** The OpenQuest agent requires sandboxing and dynamic subagents. Registration fails closed unless TrueForge, authenticated read-only GitHub MCP access, Daytona, and a commit-pinned trusted skill are ready. (`e470867`, `d1b0c14`, `47105a5`)
- **Static preflight before execution.** Preflight must report all required repository, lifecycle, path, credential, and network checks and prove that dependencies and repository scripts were not executed. Invalid or uncertain evidence quarantines the campaign. (`8d174a3`, `47105a5`)
- **Structured implementation and verification.** Child results use strict schemas, bounded artifact paths, direct evidence, session/sandbox identities, commit identities, and operation-specific validation. Late or cross-campaign results cannot mutate current campaign state. (`8d174a3`, `85289a0`, `01681b0`, `01c1485`)
- **No unsafe fallback.** Provider failure, malformed model output, unavailable sandboxing, or uncertain evidence blocks progress; test fixtures are never injected into the runtime application. (`4a7453d`, `d1b0c14`, `2f51693`)

## Durable campaign memory

- **SQLite system of record.** Migrations persist campaign identity and version, ordered events, evidence, approvals, external references, external-action claims, operation results, Qodo findings, repair receipts, and escalation reasons. (`b0b4322`, `810ebab`, `3f05244`)
- **Optimistic concurrency and identity fencing.** Version checks, repository/issue identity validation, unique constraints, and atomic writes prevent stale child sessions, approvals, or review jobs from overwriting newer campaign facts. (`810ebab`, `01681b0`, `01c1485`)
- **Restart and stale-claim recovery.** Durable claims record external actions before callbacks. Unknown outcomes and stale claims require explicit reconciliation instead of blind retry, protecting against duplicate remote writes. (`092e768`, `761d940`)
- **Revocable persistence leases.** Request deadlines and scheduler shutdown revoke store access before detaching an abort-ignoring provider, preventing late writes after the operation has ended. (`bf8d38d`, `b498db4`)
- **Sanitized public projections.** Read APIs expose bounded campaign facts while withholding approval authority, raw Qodo bodies, file locations, arbitrary event payloads, and provider internals. (`7d16ff9`, `5d4583d`, `b3ebab3`)

## Human approval boundary

- **Server-owned change briefs.** OpenQuest creates durable proposals for issue comments, assignment requests, branch pushes, pull-request creation, and pull-request updates only when the campaign is in the matching state. (`5d4583d`, `950147d`)
- **Exact-payload approval.** Authority is bound to the proposal, action digest, campaign identity, version, status, current commit, payload, and idempotency key. A user cannot approve a caller-supplied or stale payload. (`5d4583d`, `950147d`, `05a6a44`)
- **Expiring, single-use authority.** Approved proposals expire after ten minutes, are atomically consumed once, and are invalidated when durable campaign facts change. (`c4c2dfe`, `05a6a44`, `adc9703`)
- **Approval reconciliation.** Callback success, confirmed completion, confirmed non-completion, and unknown outcomes retain exact action evidence and cannot substitute a different pull request or commit. (`adc9703`, `170946c`)
- **Race-resistant approval UI.** The campaign screen refreshes authoritative facts after approval and expiry, prevents duplicate submission, cancels stale route work, and disables approval when no exact durable proposal exists. (`e55b770`, `2307baf`)
- **Issuance without publication.** The current UI and API can issue authority, but no production GitHub write adapter or HTTP execution route publishes comments, branches, or pull requests. This is a deliberate product boundary, not a hidden automation feature.

## Qodo review and bounded repair

- **Authenticated review synchronization.** A dedicated review-provider capability accepts only a canonical review locator. An independently injected authority resolves bot identity, reviewed commit, completion, tests, comments, and source URLs. (`fbbf2fb`, `1af4eff`, `b3ebab3`)
- **Strict Qodo evidence parsing.** Reviews are bounded, bot identities are allowlisted, duplicate comment IDs are checked for conflicts, cross-PR and unsafe-path evidence is rejected, and severity is derived only from explicit fields or labels. (`fbbf2fb`, `1af4eff`)
- **Fail-closed quality gate.** Passing requires successful tests, no open high/medium finding, and a disposition for every remaining non-fixed finding. Missing, malformed, incomplete, timed-out, or unavailable reviews never count as a pass. (`c4c2dfe`, `fbbf2fb`, `b3ebab3`)
- **At most three repair iterations.** Actionable reviews start a fresh isolated repair session. A fourth automatic repair is impossible; maximum iteration, failed tests, failed repair, or cancellation preserves evidence and escalates to a human. (`fbbf2fb`, `b3ebab3`)
- **Independent repair verification.** A repair commit is accepted only with a verifier receipt proving campaign/repository/PR identity, expected parentage, candidate commit, child session and sandbox, and approved test-policy results. (`b3ebab3`, `b498db4`)
- **Fresh approval for repaired updates.** Qodo synchronization cannot push a repair. Publishing a verified repair requires a new exact `update_pr` proposal and single-use approval for that pull request and commit. (`1af4eff`, `b3ebab3`)
- **Bounded background scheduler.** One review tick runs at a time, health includes scheduler/store/provider state, and shutdown fencing prevents aborted generations from persisting late results. (`a94b79e`, `bf8d38d`, `b498db4`)
- **Autonomous repository PR reviews.** `.pr_agent.toml` requests Qodo v2 `/agentic_review` on pull-request events and pushes, including test, security, and ticket-analysis sections. The Qodo GitHub App must still be installed and authorized externally. (`8a79451`)

## API and operator experience

- **Fastify campaign API.** Routes cover spaces, repository discovery, issue discovery, campaign creation/read, `preflight`/`implement`/`verify` actions, approval issuance, authenticated review synchronization, liveness, and readiness. (`a94b79e`)
- **Separated capabilities.** Mutating operator requests and review-provider synchronization use distinct bearer capabilities. Reads are sanitized, request bodies and identifiers are bounded, unknown query fields are rejected, and errors do not leak provider details. (`7d16ff9`)
- **Honest health model.** `/api/healthz` reports liveness and sanitized degradation; `/api/readyz` fails with HTTP 503 unless review authority, repair verification, scheduler, and store health are ready. (`a94b79e`, `b3ebab3`)
- **Memory-only operator credential.** The onboarding flow keeps the operator bearer token in React memory. Reloading, closing, or disconnecting clears it; it is not written to local or session storage. (`9ff9269`, `62118f6`)
- **Resumable campaign dashboard.** The UI shows the campaign timeline, direct evidence, external references, Qodo findings, quality status, escalation reason, exact change brief, approval state, and embedded parent TrueForge thread. (`e55b770`, `5d4583d`)
- **Accessible responsive interface.** The graphite/purple/lime design includes keyboard focus, semantic live/error states, responsive layouts, provenance labels, actionable retry states, and reduced-motion support. (`9ff9269`, `152ab2a`, `e5f4711`)

## TrueForge reliability

- **Strict registration and rollback.** The registration script validates the agent manifest, inventories dependencies, requires an allowlisted Git URL and full commit SHA, replaces one unambiguous skill/agent, and restores the prior skill when agent registration fails. (`e470867`, `d1b0c14`)
- **Terminal stream cleanup.** Once a terminal TrueForge event is received, OpenQuest performs bounded post-terminal draining and aborts cleanup so an open provider stream cannot hang discovery or campaign operations indefinitely. (`1dbd963`)
- **Late authentication classification.** Authentication failures arriving during terminal cleanup retain their dedicated auth classification instead of becoming a generic harness error. (`a55cab5`)

## Deployment and operations

- **Subpath-safe production build.** Vite assets and React routes support hosting at `/openquest/` while preserving root-path local development. (`06cc363`)
- **Embedded TrueForge proxy.** The campaign thread uses the same-origin `/openquest/trueforge/` path in production, including websocket upgrade support through Nginx. (`2c07f34`, `ac8f79a`)
- **VPS service definitions.** Versioned releases under `/srv/openquest/releases/<commit>` can be switched atomically through `/srv/openquest/current`; systemd units run the API and TrueForge with private environment configuration. (`ca17e47`, `af8da7f`)
- **Nginx/TLS composition.** Nginx serves the static application and proxies the API to IPv4 loopback and TrueForge to IPv6 loopback beneath the public OpenQuest prefix. (`ca17e47`, `ac8f79a`)
- **Read-only demo preflight.** `scripts/demo.ts` checks web/API health, TrueForge, GitHub MCP authorization, Daytona, agent/skill registration, trusted skill pinning, and Qodo readiness without creating campaigns or external writes. Strict mode exits non-zero if any dependency is not ready. (`2f51693`)
- **Release evidence contract.** The demo guide and `evidence/` documentation define secret-free captures and clearly separate local tests, provider readiness, and real external publication. (`2f51693`, `985cdc7`)

## Engineering and verification

- **Locked Node/TypeScript toolchain.** Node 22, npm lockfile installation, TypeScript, React, Vite, Fastify, SQLite, ESLint, Vitest, Testing Library, and Playwright form the repository toolchain. (`43c015b`)
- **Layered automated coverage.** Domain, application, adapter, API, SQLite, scheduler, component, smoke, and browser tests cover state transitions, provider contracts, persistence, concurrency, approval races, Qodo recovery, and onboarding/discovery behavior. (`43c015b` through `152ab2a`)
- **Read-only CI.** GitHub Actions installs the locked graph and runs type-check, lint, build, and tests with read-only repository permissions, bounded runtime, and superseded-run cancellation. (`2f51693`)
- **Test-only fixtures.** Catalog, repository, TrueForge, and Qodo fixtures exercise success, quarantine, duplicate, subjective, actionable, unavailable, and maximum-iteration paths without masquerading as live runtime evidence. (`200aab6`, `8d174a3`, `fbbf2fb`)

## Superseded work

- The initial IncidentForge dependency-remediation scaffold (`76bfe98`) was replaced by the OpenQuest design and implementation.
- A temporary standalone evidence-first demo (`d980520`) was merged for evaluation and then removed (`ec72bfc`) once the verified React/Fastify OpenQuest workflow became the canonical application.

## Current limitations

- The default container deliberately injects no production Qodo review authority and no independent repair verifier, so full readiness fails closed.
- No production adapter or API route executes approved GitHub writes.
- The web UI exposes the next allowed `preflight`, `implement`, or `verify` action with clear sandboxing and no-write guidance; an unavailable or unsafe provider still stops the campaign fail-closed.
- Runtime discovery has no fixture/demo fallback and requires ready TrueForge, GitHub MCP, Daytona, registered agent, and trusted skill configuration.
- SQLite and the scheduler are single-process and single-operator; there is no multi-user identity model, distributed scheduling, backup workflow, or encrypted campaign database.
- OpenQuest relies on TrueForge/Daytona for sandbox creation, isolation, and teardown and does not independently verify sandbox deletion receipts.

See [docs/knowledge-base.md](docs/knowledge-base.md) for the latest verified runtime state, [docs/architecture.md](docs/architecture.md) for system design, [docs/threat-model.md](docs/threat-model.md) for trust boundaries, and [docs/qodo-workflow.md](docs/qodo-workflow.md) for review semantics.
