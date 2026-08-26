import type { Evidence } from "./evidence.js";

export const spaces = [
  "ai_ml",
  "developer_tools",
  "web",
  "mobile",
  "data",
  "infrastructure",
  "security",
  "science",
  "social_impact",
] as const;

export type Space = (typeof spaces)[number];

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
  readonly license: string | null;
  readonly isPublic?: boolean;
  readonly signals: RepositorySignals;
  readonly evidence: readonly Evidence[];
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
  return input.affectedAreas <= 2 &&
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
