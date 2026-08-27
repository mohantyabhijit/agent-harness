# OpenQuest evidence contract

This directory is a capture checklist and naming contract, not proof that a demo occurred. Do not commit empty "pass" records or copied fixture output. Create an evidence file only after observing the corresponding event, and label unavailable, incomplete, or failed steps accurately.

## Never capture

- bearer tokens, API keys, cookies, authorization headers, private keys, or secret environment values;
- credential-bearing URLs, request/response headers, browser storage, network-inspector exports, shell history, or provider settings pages containing secrets;
- raw TrueForge, GitHub, Daytona, Qodo, or model payloads that have not been reviewed and sanitized;
- private repository content, personal notifications, unrelated usernames, local filesystem paths, or unnecessary personal data;
- fabricated identifiers, fixture JSON represented as live output, or claims inferred only from configuration.

If a secret may have been captured, stop sharing the artifact, remove it from the evidence set and Git history, rotate the credential, and record only a sanitized incident note.

## Capture checklist and filenames

Use ISO-8601 UTC timestamps in file contents and lowercase hyphenated filenames. Prefer Markdown summaries plus narrowly cropped screenshots. Keep recordings outside Git when they are large or contain third-party data; commit only a checksum and access-controlled location.

- `trueforge-sessions.md` — parent and child session IDs, operation, campaign ID, start/end time, sanitized summary, and whether the ID was observed from the provider or only the campaign record.
- `sandbox-receipts.md` — Daytona sandbox ID, child session, provision/stop/delete timestamps, provider receipt or sanitized reference, commit SHA, and artifact paths. Do not claim deletion without provider evidence.
- `approval-events.md` — campaign/proposal IDs, action type, digest, campaign version, issued/expiry/consumed times, and outcome. Do not include comment/PR bodies if they may contain unreviewed data.
- `qodo-findings-resolutions.md` — canonical GitHub review URL, allowlisted source identity, reviewed commit, finding ID/severity/status, technical disposition, repair iteration, verification receipt, and unresolved items.
- `ci-run.md` — commit SHA, workflow/run URL, event, start/end time, and observed result for type-check, lint, build, and tests.
- `pull-request.md` — canonical public PR URL, repository, branch/base, approved commit, creation time, AI disclosure location, and current outcome. Create only after independently observing the PR on GitHub.
- `demo-recording.md` — recording filename or access-controlled URL, SHA-256 checksum, capture time, demonstrated commit, readiness result, known limitations stated on camera, and secret-review sign-off.
- `screenshots/` — optional sanitized images named `<utc-timestamp>-<checkpoint>.png`, such as `2026-08-27T120000Z-preflight-quarantined.png`.

## Session template

```md
# TrueForge sessions

- Captured at (UTC):
- Campaign ID:
- Repository issue:
- Parent session ID:
- Child session ID:
- Operation:
- Sandbox/session reference:
- Observed source: provider UI | sanitized campaign projection
- Sanitized summary:
- Remaining uncertainty:
```

## Sandbox template

```md
# Sandbox receipts

- Captured at (UTC):
- Campaign ID / child session ID:
- Daytona sandbox ID:
- Commit SHA:
- Provision evidence reference:
- Stop evidence reference:
- Delete evidence reference:
- Sanitized artifact paths:
- Lifecycle claim supported: provisioned | stopped | deleted | unknown
- Remaining uncertainty:
```

## Approval template

```md
# Approval events

- Captured at (UTC):
- Campaign / proposal ID:
- Action type:
- SHA-256 action digest:
- Expected campaign version:
- Issued / expires / consumed:
- GitHub execution observed: yes | no | unknown
- Canonical outcome reference:
- Remaining uncertainty:
```

## Qodo template

```md
# Qodo findings and resolutions

- Captured at (UTC):
- Campaign / iteration:
- Pull request / reviewed commit:
- Canonical review URL:
- Allowlisted source identity:
- Authenticated provider receipt reference:
- Finding ID / severity / status:
- Technical disposition:
- Repair child / sandbox / verified commit:
- Independent verification receipt:
- Unresolved findings:
- Gate result: pass | repair | escalated | pending | unavailable
```

## CI, pull request, and recording template

```md
# Release evidence

- Captured at (UTC):
- Demonstrated commit SHA:
- CI workflow and run URL:
- Type-check / lint / build / test results:
- Pull-request URL and observed status:
- Recording location and SHA-256:
- `/api/healthz` observed result:
- `/api/readyz` observed result:
- Live providers unavailable or incomplete:
- Limitations stated during demo:
- Reviewed for secrets by / at:
```

## Evidence review before commit

1. Compare every identifier and URL with the authoritative provider.
2. Confirm timestamps include timezone and distinguish capture time from event time.
3. Confirm every pass/fail/unavailable statement is directly supported.
4. Search staged evidence for token patterns, authorization headers, cookies, private keys, query credentials, local paths, and accidental environment dumps.
5. Verify screenshots and recordings visually; text search alone is insufficient.
6. Confirm no fixture file is cited as live evidence.
7. Commit evidence separately from credentials and local runtime databases.
