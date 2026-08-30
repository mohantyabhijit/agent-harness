import type { Evidence } from "./evidence.js";

export const spaces = [
  "ai_ml",
  "developer_tools",
  "web",
  "data",
  "social_impact",
] as const;

export type Space = (typeof spaces)[number];

export const repositoryVerificationClaims = [
  "visibility",
  "license",
  "recent_activity",
  "contribution_policy",
  "external_pr_acceptance",
] as const;

export type RepositoryVerificationClaim = (typeof repositoryVerificationClaims)[number];

interface RepositoryVerificationEvidenceBase extends Evidence {
  readonly kind: "direct";
  readonly claim: RepositoryVerificationClaim;
}

export type RepositoryVerificationEvidence =
  | (RepositoryVerificationEvidenceBase & {
      readonly claim: "visibility";
      readonly verifiedValue: { readonly visibility: "public" };
    })
  | (RepositoryVerificationEvidenceBase & {
      readonly claim: "license";
      readonly verifiedValue: { readonly spdxId: string; readonly path: string };
    })
  | (RepositoryVerificationEvidenceBase & {
      readonly claim: "recent_activity";
      readonly verifiedValue: { readonly commitSha: string; readonly committedAt: string };
    })
  | (RepositoryVerificationEvidenceBase & {
      readonly claim: "contribution_policy";
      readonly verifiedValue: { readonly path: string };
    })
  | (RepositoryVerificationEvidenceBase & {
      readonly claim: "external_pr_acceptance";
      readonly verifiedValue: {
        readonly pullRequestNumber: number;
        readonly mergedAt: string;
        readonly authorAssociation: "CONTRIBUTOR" | "FIRST_TIME_CONTRIBUTOR" | "FIRST_TIMER" | "NONE";
      };
    });

export function isRepositoryVerificationEvidence(
  evidence: Evidence,
): evidence is RepositoryVerificationEvidence {
  if (evidence.kind !== "direct" || !("claim" in evidence) || !("verifiedValue" in evidence)) {
    return false;
  }
  const claim = evidence.claim;
  const verifiedValue = evidence.verifiedValue;
  if (!isRecord(verifiedValue)) return false;
  if (claim === "visibility") return verifiedValue.visibility === "public";
  if (claim === "license") {
    return typeof verifiedValue.spdxId === "string" && typeof verifiedValue.path === "string";
  }
  if (claim === "recent_activity") {
    return typeof verifiedValue.commitSha === "string" && typeof verifiedValue.committedAt === "string";
  }
  if (claim === "contribution_policy") return typeof verifiedValue.path === "string";
  return claim === "external_pr_acceptance" &&
    typeof verifiedValue.pullRequestNumber === "number" &&
    typeof verifiedValue.mergedAt === "string" &&
    typeof verifiedValue.authorAssociation === "string";
}

const retrievalFreshnessMs = 24 * 60 * 60 * 1_000;
const recentCommitMs = 180 * 24 * 60 * 60 * 1_000;
const recentMergedPullRequestMs = 365 * 24 * 60 * 60 * 1_000;
const externalAuthorAssociations = new Set(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]);
const invalidLicenseIdentifiers = new Set(["none", "noassertion", "unlicensed", "unknown", "other"]);

export function hasValidRepositoryVerification(
  repository: RepositoryCandidate,
  referenceTime: Date,
): boolean {
  if (!Number.isFinite(referenceTime.getTime()) || repository.evidence.length !== repositoryVerificationClaims.length) {
    return false;
  }
  const evidence = repository.evidence.filter(isRepositoryVerificationEvidence);
  if (evidence.length !== repositoryVerificationClaims.length || !evidence.every((item) => isFreshRetrieval(item.retrievedAt, referenceTime))) {
    return false;
  }
  const claims = new Map(evidence.map((item) => [item.claim, item]));
  if (claims.size !== repositoryVerificationClaims.length) return false;

  const visibility = claims.get("visibility");
  const license = claims.get("license");
  const activity = claims.get("recent_activity");
  const policy = claims.get("contribution_policy");
  const pullRequest = claims.get("external_pr_acceptance");
  if (visibility?.claim !== "visibility" ||
      license?.claim !== "license" ||
      activity?.claim !== "recent_activity" ||
      policy?.claim !== "contribution_policy" ||
      pullRequest?.claim !== "external_pr_acceptance") return false;

  return /^[^/\s]+\/[^/\s]+$/u.test(repository.fullName) &&
    repository.isPublic &&
    isExactRepositoryUrl(repository.url, repository.fullName) &&
    isExactRepositoryUrl(visibility.sourceUrl, repository.fullName) &&
    typeof repository.license === "string" &&
    isValidLicenseIdentifier(repository.license) &&
    license.verifiedValue.spdxId === repository.license &&
    isMatchingBlobPath(license.sourceUrl, repository.fullName, license.verifiedValue.path, isLicensePath) &&
    isMatchingCommit(activity.sourceUrl, repository.fullName, activity.verifiedValue.commitSha) &&
    isRecentTimestamp(activity.verifiedValue.committedAt, referenceTime, recentCommitMs) &&
    isMatchingBlobPath(policy.sourceUrl, repository.fullName, policy.verifiedValue.path, isContributionPolicyPath) &&
    isMatchingPullRequest(pullRequest.sourceUrl, repository.fullName, pullRequest.verifiedValue.pullRequestNumber) &&
    isRecentTimestamp(pullRequest.verifiedValue.mergedAt, referenceTime, recentMergedPullRequestMs) &&
    externalAuthorAssociations.has(pullRequest.verifiedValue.authorAssociation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFreshRetrieval(value: string, referenceTime: Date): boolean {
  const timestamp = Date.parse(value);
  const now = referenceTime.getTime();
  return Number.isFinite(timestamp) && timestamp >= now - retrievalFreshnessMs && timestamp <= now;
}

function isRecentTimestamp(value: string, referenceTime: Date, maximumAgeMs: number): boolean {
  const timestamp = Date.parse(value);
  const now = referenceTime.getTime();
  return Number.isFinite(timestamp) && timestamp >= now - maximumAgeMs && timestamp <= now;
}

function isValidLicenseIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(value) && !invalidLicenseIdentifiers.has(value.toLowerCase());
}

function githubSegments(value: string): readonly string[] | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port !== "" ||
        url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname.includes("%")) return null;
    const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    const segments = pathname.slice(1).split("/");
    return pathname.startsWith("/") && segments.every((segment) => segment !== "") ? segments : null;
  } catch {
    return null;
  }
}

function matchesRepository(segments: readonly string[], fullName: string): boolean {
  const repository = fullName.split("/");
  return segments[0]?.toLowerCase() === repository[0]?.toLowerCase() &&
    segments[1]?.toLowerCase() === repository[1]?.toLowerCase();
}

function isExactRepositoryUrl(value: string, fullName: string): boolean {
  const segments = githubSegments(value);
  return segments !== null && segments.length === 2 && matchesRepository(segments, fullName);
}

function isMatchingBlobPath(
  value: string,
  fullName: string,
  expectedPath: string,
  pathValidator: (path: string) => boolean,
): boolean {
  const segments = githubSegments(value);
  if (segments === null || segments.length < 5 || !matchesRepository(segments, fullName) || segments[2] !== "blob") return false;
  const path = segments.slice(4).join("/");
  return path === expectedPath && pathValidator(path);
}

function isLicensePath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? "";
  return /^(?:LICENSE|LICENCE|COPYING)(?:\.[A-Za-z0-9_-]+)?$/iu.test(fileName);
}

function isContributionPolicyPath(path: string): boolean {
  const fileName = path.split("/").at(-1) ?? "";
  return /^CONTRIBUTING(?:\.[A-Za-z0-9_-]+)?$/iu.test(fileName);
}

function isMatchingCommit(value: string, fullName: string, expectedSha: string): boolean {
  const segments = githubSegments(value);
  return /^[0-9a-f]{40}$/iu.test(expectedSha) && segments !== null && segments.length === 4 &&
    matchesRepository(segments, fullName) && segments[2] === "commit" && segments[3]?.toLowerCase() === expectedSha.toLowerCase();
}

function isMatchingPullRequest(value: string, fullName: string, expectedNumber: number): boolean {
  const segments = githubSegments(value);
  return Number.isSafeInteger(expectedNumber) && expectedNumber > 0 && segments !== null && segments.length === 4 &&
    matchesRepository(segments, fullName) && segments[2] === "pull" && segments[3] === String(expectedNumber);
}

export function isKnownSpace(value: string): value is Space {
  return (spaces as readonly string[]).includes(value);
}

export interface RepositorySignals {
  readonly stars: number;
  readonly recentActivity: number;
  readonly contributionGuide: boolean;
  readonly ciHealthy: boolean;
  readonly externalPrAcceptance: number;
  readonly topicMatch: number;
  readonly maintainerResponse: number;
}

export interface RepositoryCandidate {
  readonly fullName: string;
  readonly url: string;
  readonly description: string;
  readonly spaces: readonly Space[];
  readonly license: string;
  readonly isPublic: boolean;
  readonly signals: RepositorySignals;
  readonly evidence: readonly RepositoryVerificationEvidence[];
}

export interface IssueCandidate {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly clarity: number;
  readonly affectedAreas: number;
  readonly testComplexity: number;
  readonly dependencyRisk: number;
  readonly estimatedHours: number;
  readonly maintainerSignals: readonly string[];
}

export interface WeightedContribution {
  readonly signal: keyof RepositorySignals | "popularity";
  readonly weight: number;
  readonly value: number;
  readonly contribution: number;
}

export interface RepositoryScoreExplanation {
  readonly inputSignals: RepositorySignals;
  readonly weightedContributions: readonly WeightedContribution[];
  readonly evidence: readonly Evidence[];
  readonly sourceUrls: readonly string[];
  readonly retrievedAt: readonly string[];
}

export function scoreRepository(value: RepositorySignals): number {
  const popularity = Math.min(Math.log10(value.stars + 1) / 5, 1);
  return Number((
    popularity * 0.15 +
    value.recentActivity * 0.15 +
    Number(value.contributionGuide) * 0.15 +
    Number(value.ciHealthy) * 0.1 +
    value.externalPrAcceptance * 0.2 +
    value.topicMatch * 0.15 +
    value.maintainerResponse * 0.1
  ).toFixed(4));
}

export function explainRepositoryScore(
  signals: RepositorySignals,
  evidence: readonly Evidence[],
): RepositoryScoreExplanation {
  const popularity = Math.min(Math.log10(signals.stars + 1) / 5, 1);
  const weightedContributions: readonly WeightedContribution[] = [
    contribution("popularity", 0.15, popularity),
    contribution("recentActivity", 0.15, signals.recentActivity),
    contribution("contributionGuide", 0.15, Number(signals.contributionGuide)),
    contribution("ciHealthy", 0.1, Number(signals.ciHealthy)),
    contribution("externalPrAcceptance", 0.2, signals.externalPrAcceptance),
    contribution("topicMatch", 0.15, signals.topicMatch),
    contribution("maintainerResponse", 0.1, signals.maintainerResponse),
  ];

  return {
    inputSignals: signals,
    weightedContributions,
    evidence,
    sourceUrls: evidence.map((item) => item.sourceUrl),
    retrievedAt: evidence.map((item) => item.retrievedAt),
  };
}

export function classifyIssue(input: {
  readonly clarity: number;
  readonly affectedAreas: number;
  readonly testComplexity: number;
  readonly dependencyRisk: number;
  readonly estimatedHours: number;
}): "easy_win" | "long_term" {
  return input.clarity >= 0.7 &&
    input.affectedAreas <= 2 &&
    input.testComplexity < 0.6 &&
    input.dependencyRisk < 0.5 &&
    input.estimatedHours <= 6
    ? "easy_win"
    : "long_term";
}

function contribution(
  signal: WeightedContribution["signal"],
  weight: number,
  value: number,
): WeightedContribution {
  return { signal, weight, value, contribution: Number((value * weight).toFixed(4)) };
}
