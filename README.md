# OpenQuest

OpenQuest is a human-in-the-loop agent harness for open-source contributions. Its TrueForge chat helps a user choose a public repository and issue, prepares a source-backed plan, works in an isolated Daytona sandbox, explains the fix, and keeps every GitHub write behind an exact human approval.

- [Watch the demo on YouTube](https://youtu.be/ehBBt39Bv4Q)
- [View the demo post on X](https://x.com/mohantyabhijit/status/2094113731798335652?s=20)
- [See an external contribution raised by the workflow](https://github.com/tinyfish-io/tinyfish-cookbook/pull/267)

The default local composition supports the product flow but deliberately does not inject a live GitHub publisher or production Qodo review authority. Those integrations fail closed until explicitly configured.

## Setup

### Requirements

- Node.js 22 or newer and npm
- A local TrueForge instance at `http://127.0.0.1:8790`
- The following integrations configured in the TrueForge settings UI:

| Integration | What to configure |
|---|---|
| Model provider | An OpenAI API key for the checked-in `openai/gpt-5-6-luna` agent. |
| GitHub MCP | The only required MCP. Authorize it with GitHub OAuth or a suitably scoped GitHub token. The OpenQuest agent enables only `@read-only` tools; external writes remain a separate approval-gated server action. |
| Daytona | A Daytona API key and a sandbox provider whose status is `ready`. |
| Qodo | Optional for the base local app. Install and authorize Qodo on the GitHub repository, then use its verified bot login in `QODO_BOT_IDENTITIES`. Qodo is not an MCP, and the default container does not include production review/repair authority. |

Provider credentials belong in TrueForge or the provider's credential store—not in this repository or browser code. `TRUEFORGE_TOKEN` is needed only when the TrueForge instance itself requires authentication.

### Install and run

```sh
npm ci

# Local application capabilities; generate new values for every environment.
export OPERATOR_BEARER_TOKEN="$(openssl rand -hex 32)"
export REVIEW_PROVIDER_BEARER_TOKEN="$(openssl rand -hex 32)"
export QODO_BOT_IDENTITIES="the-verified-qodo-bot-login[bot]"

# TrueForge registration client.
export TRUEFORGE_URL="http://127.0.0.1:8790"
# export TRUEFORGE_TOKEN="..." # Only for an authenticated TrueForge instance.

# The skill must be pinned to a pushed, immutable commit.
export OPENQUEST_SKILL_GIT_REF="$(git rev-parse HEAD)"
npm exec -- tsx scripts/register-openquest-agent.ts --check
npm exec -- tsx scripts/register-openquest-agent.ts

npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/) and start with the TrueForge chat. Run `npm exec -- tsx scripts/demo.ts` to inspect TrueForge, the GitHub MCP, Daytona, and agent registration before a demo. Use `--strict` only after production Qodo review authority and repair verification are configured and ready.

For local verification:

```sh
npm run typecheck
npm run lint
npm run build
npm test
```

## Qodo Code Review Evidence

Every repository change follows the [change checklist](TODO.md): a focused branch and PR, recorded verification, Qodo review of the latest commit, resolution or documented disposition of findings, a follow-up Qodo review after repairs, passing GitHub checks, and an authorized maintainer merge. Direct pushes to `main` do not count as reviewed work.

[PR #16: Conversation-first repository discovery](https://github.com/mohantyabhijit/agent-harness/pull/16) is the representative merged implementation PR. Qodo surfaced unvalidated chat recommendations, insufficient claim-specific repository evidence, ranking and conversation races, and transient-session lifecycle defects; the final code fixed those findings and received an [exact-head follow-up review](https://github.com/mohantyabhijit/agent-harness/pull/16#issuecomment-5468824110) before merge. One Medium observability recommendation was [intentionally deferred with its reason recorded in the Qodo thread](https://github.com/mohantyabhijit/agent-harness/pull/16#discussion_r3889579536): cleanup remains best-effort and outcome-preserving, while durable cleanup metrics wait for a repository-wide telemetry sink rather than ad-hoc console logging. The [pull-request template](.github/pull_request_template.md) makes the same evidence and decision trail required for future changes.

[PR #20: Local contribution-flow completion](https://github.com/mohantyabhijit/agent-harness/pull/20) records the end-to-end QA closeout and its Qodo decision trail. The [initial exact-head review](https://github.com/mohantyabhijit/agent-harness/pull/20#issuecomment-5469595618) found that a reconciled branch push could lose its follow-up pull-request proposal and that a lost browser response could misreport publication. Both findings were accepted: the backend now creates the next proposal atomically during reconciliation, and the browser reloads authoritative campaign facts after an ambiguous transport failure. Follow-up review also caught fake-store parity and missing-auth retry defects; those were fixed by mirroring production duplicate-ID rejection and distinguishing pre-request authority failure from an uncertain transport result. The PR history retains every repair and the final exact-head review; no finding was dismissed.

[PR #22: Native TrueForge chat and OpenQuest redesign](https://github.com/mohantyabhijit/agent-harness/pull/22) records the local-first product repair and review evidence. The [initial exact-head Qodo review](https://github.com/mohantyabhijit/agent-harness/pull/22#issuecomment-5470066678) found that empty verified discovery was excluded, research seeds constrained the wider search, and the issue-brief response schema accepted URLs rejected by the domain validator. All three were repaired in commit [`aa9ddb9`](https://github.com/mohantyabhijit/agent-harness/commit/aa9ddb9), with each disposition recorded in its Qodo thread and follow-up review requested against the final code.

Architecture and trust boundaries are documented in [docs/architecture.md](docs/architecture.md) and [docs/threat-model.md](docs/threat-model.md). Qodo behavior is documented in [docs/qodo-workflow.md](docs/qodo-workflow.md).
