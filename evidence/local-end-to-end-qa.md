# Local end-to-end QA — 2026-08-30

Scope: issue #15, local-only. This evidence contains no credential, provider payload, or external write.

## Result

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed; the existing Vite large-chunk advisory remains informational.
- `npm test` — passed: 30 files, 514 tests.
- `npm run test:e2e` — passed: three Playwright scenarios, including the controlled contribution flow.
- `git diff --check` — passed.

The controlled contribution scenario exercises discovery, issue selection, campaign creation, brief finalization, preflight, implementation, verification, exact branch approval and execution, exact PR approval and execution, and final authoritative reload. It asserts the two exact publisher requests and blocks all external network access, so it cannot create an open-source MR/PR.

## Safety and evidence boundary

- GitHub publication was fake-backed and local; no branch, fork, issue comment, assignment, MR, or PR was created outside this repository.
- TrueForge discovery/chat, model execution, and Daytona isolation were not provider-verified in this run.
- The controlled TrueForge chat fixture triggers an upstream assistant UI update-loop error. The new error boundary contains it and preserves the campaign controls; this is resilience proof, not proof of a successful provider-backed chat turn.
- The `ce-test-browser` manual-driver run was skipped because this host exposed no integrated browser and `agent-browser` was not installed. The repository-owned Playwright suite is recorded separately and must not be represented as that manual-driver proof.
- No deployment was performed.

## Qodo review evidence

[PR #20](https://github.com/mohantyabhijit/agent-harness/pull/20) received an [initial exact-head Qodo review](https://github.com/mohantyabhijit/agent-harness/pull/20#issuecomment-5469595618). Qodo identified two valid publication-recovery defects: confirmed branch-push reconciliation did not persist the next exact pull-request proposal, and browser transport failure could state that no publication occurred without first reloading durable facts. Follow-up review found two valid repair defects: fake-store duplicate-ID behavior differed from SQLite, and a missing operator capability was incorrectly treated as an uncertain external write. All four findings were repaired and covered by focused regression tests; no finding was dismissed. The PR history records the final exact-head review and passing GitHub checks before merge.
