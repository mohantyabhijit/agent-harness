# OpenQuest threat model

## Scope and security goals

OpenQuest processes public repository content with an agent, executes selected code in an external sandbox, stores durable campaign state locally, and may eventually authorize GitHub writes. The security goals are to keep credentials out of untrusted execution, prevent one campaign from borrowing another campaign's memory or authority, ensure repository content cannot become trusted instructions, require exact human authority for every external write, preserve honest evidence, and fail closed when provider trust cannot be established.

This model covers the current local single-operator release. It does not claim that TrueForge, Daytona, GitHub, Qodo, the model provider, the local workstation, or their supply chains are infallible.

## Assets and trust boundaries

Protected assets include provider and capability tokens, GitHub identity, campaign evidence, approval authority, repository and pull-request identity, current commit state, review findings, sandbox artifacts, and the integrity of the local SQLite database.

Trust boundaries exist between:

- the browser and Fastify API;
- Fastify and the local SQLite file;
- OpenQuest and TrueForge;
- TrueForge and GitHub MCP/model providers;
- TrueForge and Daytona sandboxes;
- the Qodo locator agent and an independent authenticated review authority;
- repair child output and an independent repair verifier;
- untrusted repository/issue/review text and trusted OpenQuest instructions.

## Threats and controls

### Repository prompt injection

**Threat:** Repository files, issues, comments, review bodies, or tool output instruct the agent to reveal credentials, ignore policy, perform writes, or misreport results.

**Controls:** The trusted skill explicitly treats all repository content as data. GitHub discovery and chat enable read tools only. Application adapters parse strict, bounded envelopes and verify canonical GitHub identity. Only direct evidence is propagated into campaign packets as verified evidence. Arbitrary model output cannot mint approval authority.

**Residual risk:** A model may still reason incorrectly about malicious text. Human review, source links, narrow child goals, strict output validation, and no silent provider fallback reduce but do not eliminate this risk.

### Malicious lifecycle scripts and dependencies

**Threat:** Install, build, test, hook, generator, binary, or package lifecycle behavior exfiltrates data, escapes the workspace, or alters evidence.

**Controls:** Every execution operation uses a fresh TrueForge session configured for Daytona. Static preflight must inspect manifests/lifecycle scripts, suspicious paths, credential boundaries, network behavior, and repository metadata before dependencies or scripts run. The contract requires explicit proof that neither occurred during preflight. Uncertainty and malformed output quarantine the campaign; there is no host-execution fallback.

**Residual risk:** Static analysis cannot prove arbitrary code safe. A passing preflight can miss obfuscation or runtime behavior. Isolation depends on TrueForge/Daytona configuration and implementation.

### Credential exfiltration

**Threat:** Repository code, prompts, logs, evidence, screenshots, URLs, errors, or downloadable artifacts expose GitHub, model, TrueForge, Daytona, Qodo, operator, or review-provider credentials.

**Controls:** Credentials remain in provider stores or process memory, outside cloned repositories and campaign packets. The local Vite proxy injects the operator capability server-side and never bundles it into browser code; outside development, any browser-entered capability is password-masked and held only in React memory. HTTP errors and readiness codes are sanitized. Sandbox artifact paths are bounded and cannot be absolute or URL-like. Evidence rules forbid raw payload captures, headers, cookies, environment dumps, and provider error bodies.

**Residual risk:** A compromised local browser, process, dependency, provider, or workstation can access in-memory credentials. This MVP does not provide OS-level secret isolation or content scanning of every user-created screenshot.

### Cross-campaign leakage

**Threat:** Evidence, approvals, commits, sessions, sandbox artifacts, or issue-specific reasoning from one campaign influence another.

**Controls:** One repository issue maps to one durable campaign and parent session. Fresh child sessions receive explicit packets carrying one campaign ID, repository, issue, verified evidence, approval summaries, and current commit. Store operations are keyed and versioned by campaign. Approval and external-action claims bind the campaign identity. Sandboxes are not reused by application design.

**Residual risk:** TrueForge or Daytona provider defects could violate session isolation. The local SQLite database is shared by the process and is not encrypted or partitioned per user.

### Duplicate writes and unknown outcomes

**Threat:** Retries, crashes, timeouts, concurrent operators, or late provider responses post duplicate comments, create duplicate branches/PRs, or overwrite campaign state.

**Controls:** SQLite uniqueness, campaign versions, idempotency keys, atomic approval consumption and action claims, one scheduler tick at a time, abort signals, and revocable persistence leases fence duplicates. A callback failure becomes `outcome_unknown` and requires reconciliation; OpenQuest does not blindly retry. Stale claims require an explicit operator disposition.

**Residual risk:** The current release has no GitHub write adapter or execution route, so remote idempotency is not demonstrated. A future adapter must reconcile against canonical GitHub state before any retry.

### Approval replay or payload substitution

**Threat:** An approval is reused, applied after state changes, or attached to a different action, commit, issue, branch, PR, title, or body.

**Controls:** The server owns proposals and binds the full validated payload, SHA-256 digest, campaign/version/status, current commit, and change brief. The operator confirms every displayed field. Approvals expire after ten minutes, are single-use, require an idempotency key, and are active only while the exact durable proposal remains current. The store revalidates authority atomically when claiming execution.

**Residual risk:** SHA-256 and storage invariants do not protect a fully compromised server or database. The current UI issues authority but does not execute writes.

### Compromised or forged review comments

**Threat:** A non-Qodo actor, prompt-injected agent, stale review, or tampered payload invents a passing review, hides findings, or attaches findings to another commit or pull request.

**Controls:** The TrueForge child may return only a canonical review URL and opaque receipt. A separately injected authenticated authority must resolve identity, commit, completion, tests, and comments. Bot identities are explicitly allowlisted. Review parsing rejects cross-PR URLs, non-allowlisted actionable authors, conflicting duplicates, malformed paths, and incomplete evidence. Missing or unavailable authority never counts as pass.

**Residual risk:** The default authority is unavailable, so the live Qodo path is not release-ready. A compromised allowlisted GitHub App or authority remains within the trust base.

### Sandbox escape or persistence

**Threat:** Untrusted repository code escapes Daytona, reaches the TrueForge host or provider credentials, persists across sessions, or contaminates a later campaign.

**Controls:** The OpenQuest skill requires a fresh child session and fresh Daytona sandbox for each discovery, policy, preflight, implementation, verification, Qodo sync, and repair operation. It forbids host fallback, shared mutable worktrees, dependency caches, and credentials inside the sandbox. Only bounded artifacts and sanitized summaries return to the campaign.

**Residual risk:** OpenQuest does not directly provision or delete Daytona resources, does not request child-sandbox teardown through its current adapter, and does not verify deletion receipts. Isolation and teardown are assumptions about the configured TrueForge/Daytona integration. A sandbox-provider escape is outside the application's containment boundary and must be handled as a provider security incident.

### Local API and data exposure

**Threat:** Another local process or browser reads campaign data, invokes writes, or accesses the SQLite file.

**Controls:** Fastify binds to `127.0.0.1`. Non-GET routes require one of two distinct high-entropy bearer capabilities; the review route cannot use the operator capability. Public campaign projections omit raw review bodies, source paths/lines, approval payload authority, and arbitrary event fields. Query strings and oversized/unknown request fields are rejected.

**Residual risk:** `GET` campaign routes are intentionally unauthenticated on localhost, and SQLite is an unencrypted local file. Any same-user process may be able to read them. Do not expose the API or TrueForge directly to a network without adding transport security, origin protections, authenticated reads, and a multi-user authorization model.

## Operational requirements

- Bind OpenQuest and TrueForge to localhost for this release.
- Generate distinct operator and review-provider capabilities for each run; never commit them.
- Keep the GitHub MCP toolset read-only until a separately reviewed write adapter exists.
- Verify the exact Qodo bot login before allowlisting it.
- Treat `/api/readyz` failure as a blocked full demo, not a warning to bypass.
- Capture only the sanitized evidence listed in `evidence/README.md`.
- Rotate affected credentials and quarantine the campaign if a secret may have entered a prompt, sandbox, log, artifact, or screenshot.
- Preserve unresolved findings and failure evidence; never relabel unavailable or incomplete providers as passing.
