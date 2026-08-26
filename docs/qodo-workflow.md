# Qodo review workflow

OpenQuest treats Qodo review data as untrusted GitHub evidence. A review can block or start a repair, but it cannot approve a GitHub write, replace the campaign's current pull request or commit, or push a repaired branch.

## GitHub App and automatic review

1. Install the Qodo Merge GitHub App from Qodo's installation flow.
2. Grant it access only to the repositories OpenQuest is expected to review.
3. In Qodo, enable automatic review for newly opened pull requests in those repositories.
4. Open a controlled pull request and confirm that Qodo posts a review without a manual trigger.
5. Record the exact GitHub bot login shown on that review. Configure the server's required comma-separated `QODO_BOT_IDENTITIES` allowlist with only verified Qodo bot logins. There is no inferred or built-in identity; startup fails when the allowlist is missing.

Do not put GitHub, Qodo, or TrueForge credentials in this repository, campaign evidence, screenshots, logs, or the allowlist. Authentication stays in the GitHub App installation and the local Qodo/TrueForge credential stores.

## Local CLI

This machine was inspected with read-only help commands on 2026-08-26. The installed executable was `qodo` version `0.1.0-next.36`. Re-run `qodo --version` and `qodo review --help` before relying on these examples because the pre-release CLI can change.

The installed local-diff review command is:

```sh
qodo --json review --base origin/main --repo owner/repo --deep
```

Optional pathspecs can follow `review`. The command reviews local unpushed changes and submits data to Qodo; inspect the diff and remove secrets before running it. OpenQuest never runs this command automatically.

For an existing pull request, the installed read command is:

```sh
qodo --json pr-review-session findings --pr-url https://github.com/owner/repo/pull/7
```

`pr-review-session dismiss` and `pr-review-session mark-implemented` mutate Qodo review state. They are not part of the OpenQuest polling adapter and must not be invoked by the scheduled job. Use the Qodo UI or a separately approved operator procedure, and never mark a finding implemented until the exact repair commit is present on the pull request.

## Imported evidence

Each polling run starts a fresh TrueForge `sync_qodo` child session. Its only accepted output is `qodo_review_locator_v1`: a canonical GitHub review URL plus an opaque provider receipt. It cannot submit identity, completion, test, comment, finding, commit, or disposition facts. The same independently injected `QodoReviewAuthorityPort` resolves both scheduled locators and authenticated `POST /api/campaigns/:id/reviews/sync` locators into canonical evidence. The HTTP route rejects full review batches and extra caller-supplied facts.

The default container deliberately uses an unavailable authority. `/api/healthz` remains a liveness endpoint, while `/api/readyz` returns `503 not_ready` with the sanitized `provider_unavailable` code until authenticated Qodo/GitHub evidence resolution is configured. Zero campaigns never turns an unavailable authority into a false-ready service.

OpenQuest accepts at most 1,000 comments. It excludes non-allowlisted authors, deduplicates identical comments by GitHub comment ID, and rejects conflicting duplicates, malformed fields, unsafe paths, cross-pull-request URLs, and oversized bodies. Durable internal campaign memory preserves only:

- GitHub comment ID and discussion URL
- explicit severity, or `suggestion` when no severity label is present
- open, fixed, or dismissed status
- a concise summary and the bounded original body
- repository-relative path and positive line number
- a technical disposition for every dismissed finding

Unauthenticated campaign responses expose only the safe summary, status, severity, disposition, and validated GitHub discussion URL. Raw bodies, file paths, and line numbers remain inside authorized campaign memory and repair packets.

Alarming prose is not evidence of high or medium severity. Only an explicit Qodo severity field or an explicit `Severity:`/`Priority:` label is mapped. An explicit high/medium comment from a non-Qodo author cannot silently become a pass: the authenticated review remains incomplete for automated gating. Malformed, incomplete (even with findings), unavailable, or timed-out review output leaves the campaign in `qodo_review` without findings, iteration changes, or repair dispatch.

## Repair, approval, and escalation evidence

The quality gate passes only when required tests pass, no open high/medium finding remains, and every remaining non-fixed finding has a disposition. Otherwise OpenQuest starts one fresh `repair` child session with the current PR, current commit, review ID, iteration, and unresolved findings.

The repair child must return strict `repair_result_v1`: completed status, a new 40-character commit, passed tests, exact commands, and direct verification evidence, with no unknown fields. This is only a candidate. An injected `RepairVerifierPort`, independently bound to the campaign, repository, PR, child session, sandbox, expected parent commit, candidate commit, and explicit `openquest-repair-tests-v1` policy, must return a non-empty canonical receipt proving the commit exists and descends from that parent and that the approved tests actually passed. The bounded receipt, commands, and direct evidence are persisted with the repair operation. Without that exact receipt, OpenQuest records no repair completion, rotates no current head, and grants no `update_pr` authority.

The child may produce a new commit in its sandbox, but Qodo synchronization never pushes it. Publishing requires a new `update_pr` proposal and a fresh, single-use approval for the exact current PR, exact independently verified repair commit, current campaign version, and singleton verification receipt. The claim retains that receipt, and the store rechecks the complete operation authority atomically before the external callback. A successful approved update atomically returns the same campaign to `qodo_review` while preserving its PR, repaired commit, and iteration. If the external callback succeeds but durable completion fails, `confirmed_completed` reconciliation performs that same transition atomically and cannot change the approved PR or commit. `confirmed_not_completed` records the observed remote head only as evidence, keeps the verified local repair head and iteration, and permits a new exact proposal.

Retain non-secret evidence for each iteration:

1. Qodo review ID, reviewed commit, and source discussion URLs.
2. Normalized findings with body/path/line and dispositions.
3. Repair child session ID and bounded artifact paths.
4. Affected test commands and results.
5. The exact `update_pr` proposal, approval record, and resulting commit.
6. The next Qodo review or the final pass/escalation event.

There are at most three automatic repair iterations. Maximum-iteration, repair-failure, and repair-cancellation escalation atomically persist both `human_escalation` and its fixed reason event. When durable `qodoIteration` reaches `3`, the polling job transitions the campaign before starting another Qodo sync or repair child. There is no iteration four. Every scheduled generation and review HTTP request carries a revocable persistence lease. A shutdown or request deadline revokes that lease before detaching an abort-ignoring provider, preventing all late store access. Readiness requires live review authority, a live repair verifier, recent store health, and a running scheduler.

Verify the scheduler behavior with:

```sh
npm test -- tests/integration/jobs/qodo-review-job.test.ts
```

The escalation packet must retain unresolved findings, source links, dispositions, test evidence, repair session references, and approval history so a human can decide what happens next.
