# OpenQuest demo script

This script demonstrates only behavior that exists in the current release. It makes no claim that the default container can publish a pull request or complete authenticated Qodo repair. Use a controlled public repository and never expose credentials on screen.

## Before recording

1. Use a clean terminal and disable shell tracing. Close panes that contain tokens, cookies, provider settings, or private repositories.
2. Confirm Node.js 22 or newer and install with `npm ci`.
3. Start TrueForge on `127.0.0.1:8790`. Configure a model, authorized GitHub MCP, and a ready Daytona provider in TrueForge's own credential store.
4. Export distinct generated `OPERATOR_BEARER_TOKEN` and `REVIEW_PROVIDER_BEARER_TOKEN` values in the terminal that will start OpenQuest. Do not display them.
5. Set `QODO_BOT_IDENTITIES` to an independently verified GitHub bot login. This does not make Qodo ready by itself.
6. Set `OPENQUEST_SKILL_GIT_REF` to the full SHA of a pushed commit containing the OpenQuest skill. Check and register the skill/agent:

   ```sh
   npm exec -- tsx scripts/register-openquest-agent.ts --check
   npm exec -- tsx scripts/register-openquest-agent.ts
   ```

7. Start the stack with `npm run dev` and wait for the web, API, and TrueForge ports.
8. Run the read-only preflight:

   ```sh
   npm exec -- tsx scripts/demo.ts
   ```

   Capture the output only after checking it contains no credential-bearing URL. The expected browser URL is `http://127.0.0.1:5173/` unless `OPENQUEST_WEB_URL` was set.

## Honest readiness checkpoint

Read the `API readiness / Qodo` line aloud. In the default composition it should report not-ready, normally because the authenticated review authority or repair verifier is unavailable. This is the current release boundary. Do not edit screenshots, use fixture files, or describe this status as a live Qodo pass.

If demonstrating only implemented campaign behavior, continue with the readiness limitation visible in the evidence notes. If the goal is a full Qodo-to-repair demo, stop: that requires production implementations of both missing provider seams and is outside this release.

## Browser walkthrough

1. Open the exact browser URL printed by the preflight.
2. Enter the operator capability without exposing it. Explain that it stays only in page memory and disappears on reload, close, or **Disconnect**.
3. Describe a contribution interest in **Talk to OpenQuest**, or click a quick-start category such as **Developer tools** to navigate immediately to structured discovery.
4. Explain that chat recommendations and repository/issue cards use live TrueForge/GitHub read results with validated canonical source URLs. Background seeds are leads, not pre-verified results, and there is no Exa runtime or fixture fallback.
5. Open source evidence in a separate tab and confirm repository identity, license/activity evidence, and issue URL match the card before selecting it.
6. Start an **Easy Win** or **Long-Term Challenge**. The resulting URL contains the durable campaign ID. Record that ID in the private demo notes only if it contains no sensitive information.
7. Reload the campaign URL. Show that SQLite restores the issue identity, status, timeline, evidence, parent session ID, Qodo state, and any current approval surface.
8. In the embedded OpenQuest agent, explain that GitHub tools are read-only. Do not ask it to post, push, or create a pull request.

## Static preflight and campaign operations

The campaign screen presents only the next action allowed by durable state. Use **Start static preflight** to begin the read-only repository examination; the control explains that it creates a fresh sandbox session and performs no GitHub write. The action requires the in-memory operator capability and records a durable claim before work begins.

After completion, refresh the campaign page and show:

- the fresh child-session and sandbox/session references;
- all five static checks;
- a pinned commit SHA;
- `dependenciesInstalled: false` and `repositoryScriptsExecuted: false` during preflight;
- a `baseline` result for pass or `quarantined` for uncertainty/failure.

After a successful preflight, the same campaign screen exposes **Run isolated implementation**, followed by **Run verification**. Run them only for a controlled public repository after preflight passes. Each operation should create a new child session. A failed operation is valid demo evidence; do not rerun until the durable state and failure reason are understood.

## Exact approval boundary

When the campaign contains a current server-owned proposal, show the accessible brief: repository policy, approach, files, risks, tests, safety result, Qodo status, exact branch/commit/title/body fields where applicable, AI disclosure, and action digest.

Select the review checkbox and issue approval only if every field is correct. State clearly: this creates ten-minute, single-use authority for that exact payload and campaign version. It does not execute the action. The current release has no route or production adapter that performs the GitHub write.

If no current proposal exists, show the disabled **Approval unavailable** state. Never seed or edit SQLite to manufacture one for a recording.

## Qodo gate

Show the quality panel's iteration counter and finding dispositions only when they came from authenticated, commit-bound evidence. The gate permits at most three repair iterations. Missing, incomplete, timed-out, or unavailable Qodo evidence is pending/degraded—not passing.

The default release cannot demonstrate a live Qodo pass or independently verified repair. Use the readiness result and `docs/qodo-workflow.md` to explain the missing seams. Do not import `fixtures/qodo/*.json` into a live campaign or claim those files are provider evidence.

## Finish and capture

1. Select **Disconnect** and show that the browser requests the capability again.
2. Run the four existing release checks in a clean terminal:

   ```sh
   npm run typecheck
   npm run lint
   npm run build
   npm test
   ```

3. Save only sanitized evidence using the checklist and templates in `evidence/README.md`.
4. Review the recording frame by frame for tokens, authorization headers, cookies, environment values, private URLs, personal notifications, or raw provider payloads before sharing it.

## Claims checklist

- Say **live** only for an observed provider response recorded during this run.
- Say **configured** only for an inventory check; configuration alone is not operational evidence.
- Say **ready** only when `/api/readyz` returns HTTP 200 and the preflight reports ready.
- Say **approved** only for the exact durable proposal; approval is not execution.
- Say **Qodo passed** only for authenticated, allowlisted, current-commit review evidence and a passing durable gate.
- Say **sandbox isolated/deleted** only when a non-secret provider receipt proves it. A child session ID alone is not a deletion receipt.
- Record failures and unavailable providers as observed. Do not replace them with fixture output.
