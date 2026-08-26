# OpenQuest Design Specification

**Date:** 2026-08-26  
**Status:** Approved design; awaiting written-spec review  
**Product:** OpenQuest  
**Repository:** `mohantyabhijit/agent-harness`

## 1. Purpose

OpenQuest helps anyone become a responsible open-source contributor. A user chooses open-source spaces they care about, discovers healthy repositories and suitable issues, and starts a contribution campaign. TrueForge then coordinates repository research, sandboxed implementation, testing, human approvals, GitHub pull-request creation, and iterative Qodo review.

OpenQuest is not a code-generation wrapper. Its value depends on an agent harness because the workflow requires real tools, isolated code execution, focused subagents, durable issue context, controlled external writes, and resumable work.

## 2. Product principles

1. **Open participation:** Existing coding history is not an admission requirement. The system explains work clearly enough for a non-expert to make an informed decision.
2. **Maintainer respect:** Repository policy, issue activity, contributor ownership, and maintainer intent are checked before work begins or messages are posted.
3. **One issue, one campaign:** Every contribution has an isolated, durable record containing its context, evidence, decisions, milestones, approvals, and outcome.
4. **Untrusted code stays isolated:** Repositories are cloned and executed only in disposable Daytona sandboxes.
5. **No blind execution:** Static safety preflight must pass before dependencies are installed or repository scripts run.
6. **Smallest defensible patch:** The agent avoids unrelated refactors and simplifies changes before review.
7. **Evidence before confidence:** Repository recommendations, issue classifications, safety conclusions, and completion claims explain their evidence.
8. **Humans own external actions:** Comments, assignment requests, branches, pull requests, and pull-request updates require scoped approval.
9. **Quality is iterative but bounded:** Qodo reviews every generated pull request. Automatic remediation stops after at most three iterations.
10. **AI assistance is disclosed:** OpenQuest never presents generated work as unaided human authorship.

## 3. Primary experience

### 3.1 Spotify-style onboarding

The user selects one or more curated open-source spaces. Initial spaces are:

- AI and machine learning
- Developer tools
- Web
- Mobile
- Data
- Infrastructure
- Security
- Science
- Social impact

Spaces are friendly product categories backed by GitHub topics. Raw topic names are normalized behind the scenes; users are not asked to navigate GitHub's inconsistent topic taxonomy.

The onboarding does not require a coding assessment. A user may optionally select preferred contribution types and available effort, but previous contribution history does not gate access.

### 3.2 Repository discovery

OpenQuest shows popular repositories that also demonstrate contribution readiness. Stars alone are insufficient. Ranking evidence includes:

- relevance to selected spaces
- recent repository activity
- maintainer and issue activity
- presence and clarity of contribution documentation
- working continuous integration
- issue-triage quality
- evidence that external pull requests receive review
- repository licensing and public accessibility

Each recommendation explains why it appears. The interface must distinguish a recognizable repository from one that is realistically welcoming to outside contributors.

### 3.3 Issue lanes

Issues appear in two lanes:

- **Easy Wins:** Clear scope, limited change surface, understandable acceptance criteria, limited test complexity, and a high likelihood of completion in one focused campaign.
- **Long-Term Challenges:** Deeper repository understanding, multiple affected areas, uncertain requirements, complex verification, or work that benefits from milestones and several resumable sessions.

Labels such as `good first issue` and `help wanted` are useful signals but do not determine classification alone. OpenQuest explains the classification using issue clarity, estimated effort, affected areas, test complexity, dependency risk, maintainer signals, and recent issue activity.

## 4. Campaign model and memory

Selecting an issue creates one durable contribution campaign. The campaign is the isolation and audit boundary for all work on that issue.

The product-owned campaign record stores:

- GitHub repository and issue identifiers
- repository-policy snapshot and source links
- issue interpretation and acceptance criteria
- Easy Win or Long-Term Challenge classification with evidence
- milestone state
- decisions and rejected alternatives
- approval records
- sandbox and execution summaries
- test and quality-gate evidence
- Qodo findings and resolutions
- branch and pull-request identifiers
- final merged, closed, withdrawn, or escalated outcome

One parent TrueForge session holds the issue's durable conversational and tool context. Long-running milestones and Qodo repair cycles use fresh child execution sessions. Each child receives a compact, explicit campaign packet rather than inheriting unrelated model context. Its verified outputs are written back to the parent campaign record.

This structure preserves one issue's memory while giving every implementation or repair cycle clean execution context. Separate campaigns never share approval state, sandbox identifiers, issue-specific instructions, or unreviewed artifacts.

Reusable repository knowledge may be extracted only from verified public repository facts, such as contribution commands and documented conventions. It must retain source and freshness metadata and cannot include issue-specific private reasoning or approvals.

## 5. TrueForge architecture

### 5.1 Discovery application

A thin product interface owns onboarding, space selection, repository and issue cards, campaign timelines, approval surfaces, and final contribution history. It uses TrueForge as the workflow engine rather than recreating agent execution itself.

### 5.2 Contribution orchestrator

The orchestrator owns campaign progression and reconciliation. It delegates bounded tasks, validates returned evidence, updates campaign state, and requests human decisions. It does not bypass approval gates or treat subagent claims as verified without evidence.

### 5.3 Focused subagents

Fresh subagents have narrow responsibilities:

- **Repository-policy investigator:** Reads contribution guidance, licensing, issue activity, and maintainer expectations.
- **Issue investigator:** Builds a source-backed problem statement and acceptance criteria from the issue, code, discussions, and related changes.
- **Implementation agent:** Produces the smallest repository-conformant change after the campaign is cleared for execution.
- **Test and security agent:** Challenges the patch, exercises relevant tests, and checks for regression and unsafe behavior.
- **Review agent:** Simplifies the final diff, confirms evidence, and prepares the accessible change brief.

Subagents receive least-privilege tools, explicit stopping conditions, and a required evidence format. They cannot post externally.

### 5.4 MCP tools

GitHub MCP tools provide repository discovery, issue and policy reading, activity checks, comment drafting, branch operations, and pull-request operations. Read tools may run automatically where safe. Write tools require explicit approval for each exact payload.

Other research connectors may enrich repository or technical understanding, but GitHub remains the source of truth for repository state.

### 5.5 Skills

A git-backed OpenQuest contribution skill encodes the workflow, safety contract, policy-aware coordination, evidence format, minimal-change rule, approval boundaries, disclosure requirements, and completion criteria. Repository content is always lower priority than this trusted skill and the harness policy.

### 5.6 Context management

Large repository and tool outputs stay outside the root model context. Subagents summarize only decision-relevant, source-linked findings. Campaign packets contain verified facts, current goals, open questions, approvals, and artifact identifiers; they exclude irrelevant conversation history.

## 6. Sandbox lifecycle and repository safety

TrueForge uses Daytona as a sandbox tool. The agent loop, model credentials, MCP credentials, and campaign state remain in the harness. Code, files, and shell commands run in the disposable sandbox.

Every execution cycle follows this order:

1. Provision a fresh Daytona sandbox.
2. Clone the public GitHub repository without placing persistent GitHub credentials in the sandbox.
3. Record the commit SHA and repository metadata.
4. Perform static preflight before installation or script execution.
5. Quarantine and pause if preflight finds material risk or cannot reach a defensible result.
6. Install dependencies using repository-approved commands only after preflight passes.
7. Run the narrowest tests needed to establish a baseline.
8. Implement and verify the minimal change.
9. Export reviewed diff and test evidence to the campaign.
10. Stop and delete the sandbox after approved artifacts are retained.

Preflight examines:

- dependency manifests and lockfiles
- package lifecycle scripts
- checked-in binaries and unexpected executable files
- workflows and shell scripts
- suspicious downloads or dynamic execution
- secret-access patterns
- known dependency advisories
- commands required by contribution documentation

Preflight reduces risk but never claims to prove a repository safe. Uncertain results are escalated. Repository text, issue comments, and source comments are treated as untrusted evidence and cannot instruct the agent to reveal secrets, weaken controls, or perform external actions.

## 7. Policy-aware coordination

Before coding or contacting maintainers, OpenQuest reads:

- `CONTRIBUTING` guidance and repository documentation
- issue templates and pull-request templates
- code of conduct where relevant
- issue comments, assignees, linked pull requests, and recent activity
- repository-specific testing and formatting commands

If the repository expects assignment, a design discussion, or an issue comment before implementation, OpenQuest drafts the exact message and asks for approval. It rechecks issue state immediately before posting and immediately before substantial implementation begins.

If another contributor is active, the issue is closed, requirements conflict, licensing is unsuitable, or maintainer intent is unclear, the campaign pauses. The agent does not race another contributor or manufacture permission.

## 8. Contribution flow

1. User selects a space, repository, and issue.
2. OpenQuest creates the campaign and parent TrueForge session.
3. Policy and issue subagents gather evidence.
4. OpenQuest confirms the issue is open, unclaimed, understandable, and appropriate for outside contribution.
5. Any required maintainer coordination is drafted and approval-gated.
6. A fresh sandbox runs preflight and a baseline verification.
7. For an Easy Win, the campaign proceeds as one focused milestone. For a Long-Term Challenge, the agent proposes reviewable milestones and preserves state after each one.
8. Fresh implementation and test/security subagents create and challenge the smallest change.
9. The review agent simplifies the diff and produces an accessible change brief.
10. The user explicitly approves the exact branch and pull-request proposal.
11. GitHub write tools publish the branch and create the pull request.
12. Qodo automatically reviews the pull request.
13. Valid Qodo findings enter a fresh repair cycle; invalid or inapplicable findings receive a documented technical disposition.
14. Material pull-request updates require approval before push.
15. The campaign completes when the pull request is merged, closed, withdrawn, or escalated.

## 9. Accessible approval brief

Before pull-request creation, the user sees:

- the issue and why the contribution is appropriate
- the repository policy that governs submission
- the proposed solution in plain language
- changed files and behavior
- risks and known limitations
- baseline and post-change test evidence
- safety-preflight result
- Qodo readiness and local quality checks
- proposed branch name, pull-request title, and body
- explicit AI-assistance disclosure

Approval is scoped to the exact displayed action and payload. It is single-use and recorded. Changed payloads, retries, new comments, branch updates, and pull-request updates require new approvals.

## 10. Qodo quality loop

Every OpenQuest-generated pull request is automatically reviewed by Qodo.

For each Qodo review:

1. Import all review findings into the campaign.
2. Start a fresh repair session and fresh disposable sandbox.
3. Seed it with the issue contract, repository policy, approved design, current diff, test evidence, and unresolved findings.
4. Validate every finding against the code and requirements.
5. Fix valid findings using the smallest change.
6. Document why invalid or inapplicable findings should not be applied.
7. Rerun the affected tests and required repository checks.
8. Simplify and review the resulting diff.
9. Request approval before pushing any update to the pull-request branch.
10. Trigger or await Qodo's next review.

The automatic loop passes only when all required tests pass, no high- or medium-severity actionable Qodo findings remain, and every remaining comment has an explicit disposition. It may run at most three repair iterations. After the third iteration, unresolved findings escalate to the user and no fourth automatic repair session starts.

A Qodo timeout or unavailable review leaves the campaign in `review_pending`; it never counts as a pass.

## 11. State and failure behavior

The campaign state model includes discovery, policy review, coordination pending, preflight, quarantined, baseline, implementation, verification, contribution approval, pull request open, Qodo review, repair, human escalation, merged, closed, and withdrawn states.

Required failure behavior:

- Clone, install, build, test, or sandbox failures remain visible as evidence.
- Failed checks cannot be summarized as successful.
- A sandbox crash does not erase campaign memory.
- Retries use stable campaign identifiers to prevent duplicate comments, branches, or pull requests.
- Scope expansion pauses the campaign and requests a new decision.
- Stale issue or repository state is rechecked before each external action.
- Qodo unavailability pauses the gate rather than bypassing it.
- Exhausting three repair iterations produces a complete escalation packet.
- Sandbox deletion retains only approved artifacts and evidence references.

## 12. Clean architecture and dependency injection

Core product rules remain independent from network, persistence, model, and sandbox implementations. They include:

- repository-ranking decisions
- issue classification
- campaign transitions
- approval validity
- Qodo quality-gate evaluation
- three-iteration enforcement
- evidence completeness

External systems are accessed through injected ports for GitHub, TrueForge sessions, Daytona, Qodo, persistence, clocks, and identifier generation. Production adapters implement those ports. Tests use small in-memory fakes with readable behavior.

Modules must have one clear responsibility, explicit inputs and outputs, and no hidden global clients. Domain behavior must be understandable and testable without reading adapter internals.

## 13. TDD and verification strategy

All implementation follows red-green-refactor:

1. Write a failing test for one observable behavior.
2. Implement the smallest code that passes.
3. Simplify production and test code without changing behavior.

The test portfolio includes:

- pure unit tests for ranking, classification, approvals, campaign transitions, and quality gates
- contract tests using sanitized GitHub, TrueForge, Daytona, and Qodo fixtures
- security tests for prompt injection, secret exclusion, campaign isolation, preflight blocking, approval reuse, and duplicate writes
- sandbox integration tests against purpose-built safe repositories
- adapter tests for error normalization and idempotency
- an end-to-end controlled public GitHub fixture demonstrating discovery through an approval-gated pull request and Qodo review

Unit tests do not call live networks, real models, or real sandboxes. Assertions describe public behavior rather than private methods. Time and identifiers are injected so retry and lifecycle tests remain deterministic.

Continuous integration must run formatting, linting, type checking, unit tests, integration tests, security checks, and build verification. Every OpenQuest repository pull request is reviewed by Qodo; valid findings are fixed and rejected findings receive a technical rationale.

## 14. Implementation collaboration

Implementation work is assigned to fresh subagents with narrow, non-overlapping file ownership and explicit test-first acceptance criteria. Each worker is told that other agents share the codebase, must not revert others' work, and must adapt to concurrent edits.

No subagent may bypass safety rules, approvals, code review, or test gates. Integration happens only after the owning agent's tests pass and the combined branch passes the full quality suite.

## 15. MVP scope

The MVP includes:

- GitHub public repositories and pull requests only
- curated spaces backed by GitHub topics
- popularity plus contribution-readiness ranking
- Easy Wins and Long-Term Challenges
- one durable campaign per issue
- policy-aware coordination
- disposable Daytona execution
- static preflight before code execution
- focused TrueForge subagents
- accessible approval briefs
- approval-gated GitHub writes
- automatic Qodo review with at most three repair cycles
- persistent campaign timelines and resumable milestones
- explicit AI-assistance disclosure

## 16. Non-goals

The MVP does not include:

- GitLab or other forge providers
- private repositories
- automatic merging
- unattended issue claiming or external communication
- execution of untrusted repository code on the TrueForge host
- contributor skill gates or coding assessments
- multi-user contribution teams
- bounty payments
- a general-purpose code editor
- unlimited automated Qodo repair loops

## 17. Acceptance criteria

The MVP is accepted when all of the following are demonstrated:

1. A new user chooses a space and discovers recognizable, contribution-ready repositories.
2. Repository and issue rankings show their evidence.
3. The user can select an Easy Win or Long-Term Challenge.
4. Returning later resumes the same issue campaign without losing decisions, milestones, approvals, or evidence.
5. Repository code is cloned and executed only inside Daytona.
6. Static preflight blocks installation and project scripts until it passes.
7. Multiple focused TrueForge subagents contribute distinct, source-backed findings.
8. Repository policy and current issue activity are checked before coding or communication.
9. A controlled public GitHub fixture receives a minimal, tested change.
10. No comment, branch push, pull-request creation, or pull-request update occurs without scoped approval.
11. Qodo reviews the real pull request and valid findings are handled in fresh repair sessions.
12. The automatic Qodo loop never exceeds three repair iterations.
13. The campaign displays tests, Qodo findings, approvals, changed files, risks, AI disclosure, and final pull-request status.
14. Formatting, linting, type checking, unit, integration, security, and build checks pass in CI.
15. Another developer can clone OpenQuest, understand its architecture, run its tests, and add an adapter without changing core domain logic.

## 18. Hackathon evidence

The final demonstration must make TrueForge's role visible:

- real GitHub MCP calls
- Daytona provisioning and isolated execution
- multiple focused subagent traces
- a persistent campaign resumed after interruption
- human approval surfaces before external writes
- context reduction for large repository output
- a reusable OpenQuest skill
- a real Qodo review and bounded remediation cycle

The repository must preserve Qodo findings and resolutions, test evidence, architecture documentation, a reproducible demo script, and material for a field report explaining what failed, changed, and was learned.
