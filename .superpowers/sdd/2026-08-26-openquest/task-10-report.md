# Task 10 Report: Bounded Qodo Review and Repair

## Outcome

Implemented a production `QodoReviewPort`, strict GitHub/Qodo comment normalization, a fresh-session TrueForge adapter, durable source-evidence fields, and a single-flight scheduled review loop that cannot start an automatic fourth repair.

## TDD evidence

### Qodo parser and adapter RED

Command:

`npm test -- tests/unit/adapters/qodo/github-review-parser.test.ts tests/unit/adapters/qodo/trueforge-qodo-review.test.ts`

Initial result: both suites failed because `github-review-parser` and `trueforge-qodo-review` did not exist. After the first implementation, three behavior tests remained RED because markdown severity labels were not recognized. The parser was corrected and the focused slice passed 16 tests.

### Durable source evidence RED

Command:

`npm test -- tests/integration/sqlite/campaign-store.test.ts tests/unit/application/sync-review.test.ts tests/unit/server/support.test.ts`

Initial result: SQLite dropped body/path/line and the strict review batch rejected them. The domain, batch parser, SQLite schema/migration, fake store, server projection, and browser DTO were expanded with optional bounded source fields and strict all-or-none location validation. The focused slice passed 106 tests.

### Scheduled job RED

Command:

`npm test -- tests/integration/jobs/qodo-review-job.test.ts`

Initial result: five failures showed the old job never called `QodoReviewPort`, did not persist normalized findings through that port, and did not escalate iteration three without another provider child. The job was integrated with the new port while retaining its prior injected compatibility seam for existing tests.

A later authority regression test proved that iteration-three escalation mutated state before validating the singleton current PR. Validation was moved before the optimistic state claim. The final job slice passed 9 tests.

### Strict provider ingress RED

The SyncReview strict-batch table added a non-GitHub source URL. It initially reached repair, proving the URL boundary was too broad. The batch now accepts only bounded HTTPS GitHub pull-request discussion fragment URLs.

## Implementation decisions

- Qodo authors are matched case-insensitively against the configured `QODO_BOT_IDENTITIES` allowlist. Non-allowlisted comments are excluded before their unrelated payload fields are parsed.
- Allowlisted Qodo comments are strict and bounded: exact known keys, positive safe GitHub ID/line, safe relative path, body at most 20,000 characters, and source URL tied to the requested repository, PR, and discussion ID.
- Explicit structured severity or an explicit `Severity:`/`Priority:` body label is mapped. Missing severity becomes `suggestion`; alarming prose is never promoted heuristically.
- Identical comments deduplicate by GitHub comment ID. Conflicting duplicates fail closed.
- Dismissed findings require a technical disposition. The durable finding keeps a concise derived summary plus the complete bounded body/path/line/source URL.
- `TrueForgeQodoReview` rebuilds a session-safe campaign packet and starts a fresh `sync_qodo` child with the active abort signal and timeout. It validates repository, PR number, commit SHA, review identity, completeness, tests, and comment bounds before normalization.
- Provider unavailable, malformed, incomplete-empty, stale-commit, cross-repository, duplicate-ID, and oversized results do not pass the gate or create repair writes.
- A later review does not rewrite or re-emit an unchanged durable finding; new or changed statuses/source evidence are still upserted.
- `QodoReviewJob` remains single-flight. It polls only `qodo_review`, passes one abort/deadline context through Qodo sync and repair, and leaves provider failures retryable.
- At durable iteration three, the job validates singleton current PR/current commit and claims `human_escalation` before any Qodo sync or repair child. No iteration four exists.
- Repair children receive `externalWritesAllowed: false` and `publicationRequiresFreshUpdatePrApproval: true`. Existing version-fenced repair completion and atomic `update_pr` authority remain unchanged: exact current PR, exact current commit, current campaign version/iteration, completed repair output, and fresh single-use approval are all required before the external callback.
- Qodo synchronization itself performs no push, PR update, dismissal, or mark-implemented mutation.

## Fixtures and documentation

Added pass, actionable, subjective, duplicate, unavailable, and third-iteration fixtures. Added `docs/qodo-workflow.md` covering GitHub App automatic review, configured bot identities, local CLI use, retained evidence, approval boundaries, and three-cycle escalation.

Read-only local CLI inspection found:

- executable: `/Users/abhijitmohanty/.local/bin/qodo`
- version: `0.1.0-next.36`
- local review command: `qodo --json review --base origin/main --repo owner/repo --deep`
- PR findings command: `qodo --json pr-review-session findings --pr-url <pull-request-url>`

No local review, Qodo mutation, GitHub mutation, TrueForge live session, or external write was executed.

## Final verification

- `npm test -- tests/unit/adapters/qodo tests/integration/jobs` — PASS, 3 files / 25 tests.
- `npm test` — PASS, 25 files / 389 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS. Vite retained the pre-existing large-chunk advisory for TrueForge/Monaco assets.
- `git diff --check` — PASS.

## Live limitations

- The GitHub App installation, automatic review trigger, configured TrueForge GitHub MCP session, and exact live Qodo bot login were not verified against the network in this task.
- The detected Qodo CLI is a `next` release; commands are documented with a date and must be rechecked before a live run.
- Provider behavior is covered through strict fixtures and injected harness/port seams. Live evidence still requires a controlled PR in an authorized repository.

## Fix Round 1

Addressed every load-bearing review finding with a trust-boundary redesign and new adversarial tests.

- Child/model `qodo_github_review_v1` JSON is now only a locator/summary candidate. `TrueForgeQodoReview` requires an injected `QodoReviewAuthorityPort` to independently authenticate the GitHub review URL/ID, configured Qodo identity, repository, PR, commit, and opaque receipt. Canonical authority fields override child claims; receipt/identity mismatches fail closed. The default container uses an explicit unavailable authority until a real authenticated GitHub adapter is injected.
- `QODO_BOT_IDENTITIES` is now required configuration with no inferred default. A configured Qodo allowlist is validated before startup.
- An explicit non-Qodo high/medium comment makes an otherwise complete review ineligible for automated gating instead of silently passing.
- Every `complete: false` batch, including one containing findings or `testsPassed: true`, is a no-op: no campaign version/status/iteration change, no finding/event write, and no repair dispatch.
- Review claim, findings, provenance events, quality-gate outcome, campaign version, status, and iteration are persisted through one new atomic `CampaignStore.applyQodoReview` operation in both SQLite and the fake. A real SQLite abort trigger proves the whole write rolls back. Repair dispatch occurs only after that transaction commits.
- Repair output is strict `repair_result_v1`: completed status, a new commit, passed tests, exact commands, and direct verification evidence, with unknown fields rejected. Missing/failed output escalates without recording repair completion or `update_pr` authority.
- Exact approved `update_pr` completion now atomically returns `repair` to `qodo_review` while preserving the singleton PR, repaired commit, and current iteration. The end-to-end test exercises iterations 1 through 3 using real proposal/approval/action completion paths and no direct campaign-status mutation.
- Fresh sync session identity, authenticated review provenance, and the exact response contract/field semantics are retained in the packet and durable internal events. Unauthenticated campaign projections no longer expose raw Qodo body/path/line.
- Scheduler enumeration and per-campaign failures are contained. Scheduled callbacks cannot produce an unhandled rejected promise, and sanitized `ready`/`running`/`degraded` health is available through the job and `/api/healthz`.

Verification:

- `npm test -- tests/unit/adapters/qodo/trueforge-qodo-review.test.ts tests/unit/application/sync-review.test.ts tests/integration/jobs/qodo-review-job.test.ts` — PASS.
- `npm test -- tests/integration/sqlite/campaign-store.test.ts` — PASS.
- `npm test` — PASS, 25 files / 398 tests.
- `npm run typecheck` — PASS.
- `npm run lint` — PASS.
- `npm run build` — PASS; Vite retained the existing large-chunk advisory.
- `git diff --check` — PASS.

Remaining live limitation: a live authenticated GitHub/Qodo evidence adapter and controlled PR receipt still need Task 12 provider verification. Until that adapter is injected, the production review job reports sanitized degraded health and makes no quality-gate mutation.

## Fix Round 2

Closed the remaining trust, durability, shutdown, and readiness findings.

- Replaced the Qodo child contract with locator-only `qodo_review_locator_v1`. Both scheduled polling and the review-provider HTTP route now resolve a canonical URL/opaque receipt through the same `QodoReviewAuthorityPort`; HTTP callers cannot supply identity, completion, tests, findings, comment IDs, commit state, or dispositions.
- Made authenticated identical review replay an idempotent no-op while rejecting a conflicting batch for the same review ID. Repeated scheduled pass polling remains healthy and version-stable.
- Added `RepairVerifierPort`. Repair JSON is only a candidate until an injected verifier proves repository/child/sandbox binding, expected-parent ancestry, commit existence, and executed tests. Missing or rejecting verification records no completion, rotates no head, and creates no `update_pr` authority.
- Added atomic Qodo escalation persistence for the iteration limit, repair failure, and cancellation. Status and fixed reason evidence either commit together or roll back together.
- Made `confirmed_completed` reconciliation of the exact approved `update_pr` atomically close the uncertain claim, record reconciliation evidence, preserve the singleton PR/commit and Qodo iteration, increment the campaign version, and return `repair` to `qodo_review`.
- Added scheduler generations. A provider that ignores abort is detached at the shutdown deadline, health becomes sanitized `shutdown_timeout`, late output is fenced, and a later start can run a fresh generation without unhandled rejection.
- Added readiness distinction. The default unavailable authority reports `provider_unavailable`; `/api/readyz` returns 503 even with zero campaigns, while `/api/healthz` remains available for liveness diagnostics.
- Added adversarial coverage for attacker identities, receipts, repository URLs, finding IDs, fake commits, echo-only commands, attacker evidence URLs, repeated reviews, uncertain completion reconciliation, cancellation, and unavailable-provider startup.

Final verification:

- Focused Qodo/repair/API/job/SQLite slice: PASS, 5 files / 174 tests.
- Full suite: PASS, 25 files / 416 tests.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run build`: PASS; Vite retained the existing large-chunk advisory.
- `git diff --check`: PASS.

## Fix Round 3

Closed the remaining generation-fencing, repair-authority, reconciliation, route-deadline, replay, and readiness gaps without adding new test cases, per the updated implementation-only scope.

- Added revocable persistence leases to scheduled review generations. `SyncReview` checks the current lease after every provider or harness await, before every subsequent store access, and store adapters re-check it inside atomic review, escalation, and child-result transactions. Shutdown timeout revokes the lease before detaching the old generation; late repair output cannot touch a closed or restarted SQLite store.
- Replaced the loose repair verifier result with a strict, bounded receipt bound to campaign, repository, PR, child session, sandbox, expected parent, candidate commit, explicit `openquest-repair-tests-v1` policy, passed tests, commands, and direct evidence. The canonical receipt is persisted in both operation provenance and the operation-result table. An `update_pr` claim now requires the exact verified operation result and durably retains its receipt.
- `confirmed_not_completed` reconciliation for `update_pr` now records the observed remote head only as reconciliation evidence. It preserves the locally verified repair head, repair status, version, and Qodo iteration so a fresh exact proposal can be issued.
- The review-provider HTTP route now has a real deadline and request-abort fence. Timeout returns a bounded 503 and revokes persistence authority; a provider that ignores abort cannot write later.
- Authenticated replay compares canonical findings by finding ID, independent of input ordering.
- Production readiness now depends dynamically on review authority, repair verifier, recent store health, and scheduler lifecycle. Startup runs an immediate health tick; loss, stale health, shutdown, and recovery are reflected without leaking provider details.

Implementation compatibility updated existing SQLite repair-authority fixtures only; no new tests were added.

Verification:

- Existing full suite: PASS, 25 files / 416 tests.
- Focused Qodo job/API suite: PASS, 2 files / 47 tests.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run build`: PASS; Vite retained the existing large-chunk advisory.
- `git diff --check`: PASS.
- Live/manual HTTP timeout smoke: 503, campaign version unchanged, zero durable events.
- Live/manual SQLite shutdown/restart smoke: detached generation reported `shutdown_timeout`; restarted campaign remained `repair` at the reviewed head with no late repair commit.
- Live/manual readiness smoke: `health_stale` -> ready -> provider unavailable -> repair verifier unavailable -> ready -> scheduler stopped.
