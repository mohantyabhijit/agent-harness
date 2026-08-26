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
