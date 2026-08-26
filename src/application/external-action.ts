import { createHash } from "node:crypto";

export type ExternalActionPayload =
  | Readonly<{ action: "post_issue_comment"; repository: string; issueNumber: number; body: string }>
  | Readonly<{ action: "request_assignment"; repository: string; issueNumber: number; assignee: string }>
  | Readonly<{ action: "push_branch"; repository: string; issueNumber: number; branch: string; commitSha: string }>
  | Readonly<{ action: "create_pr"; repository: string; issueNumber: number; branch: string; baseBranch: string; commitSha: string; title: string; body: string }>
  | Readonly<{ action: "update_pr"; repository: string; issueNumber: number; pullRequest: string; branch: string; commitSha: string; body: string }>;

export function canonicalExternalActionJson(payload: ExternalActionPayload): string {
  validateExternalActionPayload(payload);
  const keys = Object.keys(payload).sort();
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, payload[key as keyof ExternalActionPayload]])));
}

export function externalActionDigest(payload: ExternalActionPayload): string {
  return `sha256:${createHash("sha256").update(canonicalExternalActionJson(payload)).digest("hex")}`;
}

export function validateExternalActionPayload(payload: ExternalActionPayload): void {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(payload.repository) || !Number.isSafeInteger(payload.issueNumber) || payload.issueNumber < 1) throw new Error("Invalid external action payload");
  const nonempty = (value: string, maximum = 20_000): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !hasControlCharacter(value);
  const branch = (value: string): boolean => nonempty(value, 255) && /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]+(?<![./])$/u.test(value);
  const sha = (value: string): boolean => /^[0-9a-f]{40}$/u.test(value);
  switch (payload.action) {
    case "post_issue_comment": assertKeys(payload, ["action", "repository", "issueNumber", "body"]); if (!nonempty(payload.body)) throw new Error("Invalid external action payload"); break;
    case "request_assignment": assertKeys(payload, ["action", "repository", "issueNumber", "assignee"]); if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(payload.assignee)) throw new Error("Invalid external action payload"); break;
    case "push_branch": assertKeys(payload, ["action", "repository", "issueNumber", "branch", "commitSha"]); if (!branch(payload.branch) || !sha(payload.commitSha)) throw new Error("Invalid external action payload"); break;
    case "create_pr": assertKeys(payload, ["action", "repository", "issueNumber", "branch", "baseBranch", "commitSha", "title", "body"]); if (!branch(payload.branch) || !branch(payload.baseBranch) || !sha(payload.commitSha) || !nonempty(payload.title, 256) || !nonempty(payload.body)) throw new Error("Invalid external action payload"); break;
    case "update_pr": assertKeys(payload, ["action", "repository", "issueNumber", "pullRequest", "branch", "commitSha", "body"]); if (!branch(payload.branch) || !sha(payload.commitSha) || !nonempty(payload.body) || payload.pullRequest.length > 2_048 || !isPullRequest(payload.pullRequest, payload.repository)) throw new Error("Invalid external action payload"); break;
    default: throw new Error("Invalid external action payload");
  }
}

function assertKeys(value: object, allowed: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error("Invalid external action payload");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function isPullRequest(value: string, repository: string): boolean {
  return new RegExp(`^https://github\\.com/${escapeRegExp(repository)}/pull/[1-9][0-9]*$`, "u").test(value);
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
