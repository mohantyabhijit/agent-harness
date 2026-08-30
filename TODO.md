# OpenQuest change checklist and work queue

This file is the operating checklist for every repository change. It turns the project’s Qodo, pull-request, and open-source practices into work that can be inspected later. Update the relevant item and link the issue, PR, review thread, or verification evidence in the pull request; do not mark an item complete based only on local work.

## Required for every change

- [ ] Create or link the tracking issue when one exists; keep the change focused enough to review in one sitting.
- [ ] Work on a descriptive branch (`codex/<short-purpose>` by default), never by directly pushing to `main`.
- [ ] Write a clear PR title and description covering the change, why it is needed, risks, and the verification actually run.
- [ ] Run the applicable local checks and include their exact results in the PR. For most code changes: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and `git diff --check`.
- [ ] Confirm Qodo reviewed the latest PR commit. Resolve every valid High-severity finding; respond in the Qodo thread when a finding is incorrect, deferred, or intentional, with the reason recorded there.
- [ ] Push repairs, then trigger or wait for a follow-up Qodo review against the final code. Medium and Low findings remain an engineering decision, but the decision must be visible.
- [ ] Confirm required GitHub checks pass and leave the final merge decision to a human reviewer.
- [ ] After merge, update this queue, the PR, and any affected README or operational documentation with durable, non-secret evidence.

## Current work queue

- [ ] **Production provider readiness:** configure the production TrueForge tenant with secret-managed Daytona and model-provider credentials; register the OpenQuest agent from the immutable deployed ref; verify authenticated discovery and a non-`provider_unavailable` readiness result. See [docs/knowledge-base.md](docs/knowledge-base.md#hosted-runtime-verification-2026-08-28).
- [ ] **Qodo operating proof:** for each new substantive PR, retain the review thread, findings/dispositions, repair commit (if any), and the follow-up review. The representative completed example is [PR #3](https://github.com/mohantyabhijit/agent-harness/pull/3).
- [ ] **Dependency follow-up:** rerun `npm audit --omit=dev`, assess any remaining advisories, and track any remediation as a focused issue and PR.

## Evidence standard

Use links and concise facts, not credentials, tokens, raw provider logs, or screenshots containing secrets. A healthy local service, an open PR, or a configured local Qodo client is not by itself proof that production providers, Qodo review, CI, and a human merge are complete.
