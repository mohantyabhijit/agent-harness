import type { Campaign } from "../src/domain/campaign.js";
import type { Evidence } from "../src/domain/evidence.js";
import type { QodoFinding } from "../src/domain/quality-gate.js";

export function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "campaign-1",
    repository: "owner/repo",
    issueNumber: 42,
    issueUrl: "https://github.com/owner/repo/issues/42",
    parentSessionId: "session-1",
    lane: "easy_win",
    status: "policy_review",
    qodoIteration: 0,
    version: 1,
    ...overrides,
  };
}

export function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "evidence-1",
    sourceUrl: "https://github.com/owner/repo/issues/42",
    retrievedAt: "2026-08-26T00:00:00Z",
    observation: "Issue is open",
    kind: "direct",
    ...overrides,
  };
}

export const openHighFinding: QodoFinding = {
  id: "qodo-1",
  severity: "high",
  status: "open",
  summary: "Unsafe retry",
};
