# OpenQuest change checklist and work queue

This file is the operating checklist for every repository change. It turns the project’s Qodo, pull-request, and open-source practices into work that can be inspected later. Update the relevant item and link the issue, PR, review thread, or verification evidence in the pull request; do not mark an item complete based only on local work.

## Required for every change

- [ ] Create or link the tracking issue when one exists; keep the change focused enough to review in one sitting.
- [ ] Work on a descriptive branch (`codex/<short-purpose>` by default), never by directly pushing to `main`.
- [ ] Write a clear PR title and description covering the change, why it is needed, risks, and the verification actually run.
- [ ] Run the applicable local checks and include their exact results in the PR. For most code changes: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Confirm Qodo reviewed the latest PR commit. Resolve every valid High-severity finding; respond in the Qodo thread when a finding is incorrect, deferred, or intentional, with the reason recorded there.
- [ ] Push repairs, then trigger or wait for a follow-up Qodo review against the final code. Medium and Low findings remain an engineering decision, but the decision must be visible.
- [ ] Confirm required GitHub checks pass and leave the final merge decision to an authorized maintainer (a human or an explicitly user-authorized agent).
- [ ] After merge, update this queue, the PR, and any affected README or operational documentation with durable, non-secret evidence.

## Current work queue

- [x] **Conversation-first discovery:** shipped [issue #11](https://github.com/mohantyabhijit/agent-harness/issues/11) in Qodo-reviewed [PR #16](https://github.com/mohantyabhijit/agent-harness/pull/16), with TrueForge chat as the primary entry and structured category discovery as the validated result path.
- [x] **Issue brief and finalization:** shipped [issue #12](https://github.com/mohantyabhijit/agent-harness/issues/12) in Qodo-reviewed [PR #17](https://github.com/mohantyabhijit/agent-harness/pull/17), keeping the source-backed fix brief discussable until explicit durable finalization.
- [x] **Finalized sandbox workflow:** shipped [issue #13](https://github.com/mohantyabhijit/agent-harness/issues/13) in Qodo-reviewed [PR #18](https://github.com/mohantyabhijit/agent-harness/pull/18), with work gated behind finalization and fresh TrueForge/Daytona child sessions.
- [x] **Approved GitHub publication:** shipped [issue #14](https://github.com/mohantyabhijit/agent-harness/issues/14) in Qodo-reviewed [PR #19](https://github.com/mohantyabhijit/agent-harness/pull/19), with separate exact approvals for branch publication and pull-request creation through a server-only publisher capability.
- [x] **Local contribution-flow QA:** completed [issue #15](https://github.com/mohantyabhijit/agent-harness/issues/15) in Qodo-reviewed [PR #20](https://github.com/mohantyabhijit/agent-harness/pull/20), with deterministic end-to-end browser evidence and no deployment or third-party write.
- [x] **Native chat and product redesign:** completed in Qodo-reviewed [PR #22](https://github.com/mohantyabhijit/agent-harness/pull/22) for [issue #21](https://github.com/mohantyabhijit/agent-harness/issues/21), with the native TrueForge UI first, a Stripe-like light system, resilient validated discovery, and an authenticated native-chat proxy boundary.
- [ ] **Verified discovery snapshots:** track SQLite-backed repository and issue snapshots, startup warm-up, stale-while-revalidate responses, and visible verification metadata in [issue #23](https://github.com/mohantyabhijit/agent-harness/issues/23).
- [ ] **Production provider readiness:** configure the production TrueForge tenant with secret-managed Daytona and model-provider credentials; register the OpenQuest agent from the immutable deployed ref; verify authenticated discovery and a non-`provider_unavailable` readiness result. See [docs/knowledge-base.md](docs/knowledge-base.md#hosted-runtime-verification-2026-08-28).
- [ ] **Qodo operating proof:** for each new substantive PR, retain the review thread, findings/dispositions, repair commit (if any), and the follow-up review. The representative completed example is [PR #3](https://github.com/mohantyabhijit/agent-harness/pull/3).
- [ ] **Dependency follow-up:** rerun `npm audit --omit=dev`, assess any remaining advisories, and track any remediation as a focused issue and PR.

## Evidence standard

Use links and concise facts, not credentials, tokens, raw provider logs, or screenshots containing secrets. A healthy local service, an open PR, or a configured local Qodo client is not by itself proof that production providers, Qodo review, CI, and an authorized merge are complete.
