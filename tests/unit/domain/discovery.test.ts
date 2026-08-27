import { describe, expect, it } from "vitest";
import { classifyIssue, explainRepositoryScore, scoreRepository } from "../../../src/domain/discovery.js";

describe("discovery scoring", () => {
  it("ranks contribution readiness above stars alone", () => {
    const famousDormant = scoreRepository({ stars: 100_000, recentActivity: 0, contributionGuide: false, ciHealthy: false, externalPrAcceptance: 0, topicMatch: 1, maintainerResponse: 0 });
    const healthy = scoreRepository({ stars: 8_000, recentActivity: 1, contributionGuide: true, ciHealthy: true, externalPrAcceptance: 0.8, topicMatch: 1, maintainerResponse: 0.9 });

    expect(healthy).toBeGreaterThan(famousDormant);
  });

  it("classifies complex multi-area work as long term", () => {
    expect(classifyIssue({ clarity: 0.8, affectedAreas: 4, testComplexity: 0.9, dependencyRisk: 0.7, estimatedHours: 20 })).toBe("long_term");
  });

  it("requires clarity of at least 0.7 for an easy win", () => {
    const otherwiseEasy = { affectedAreas: 1, testComplexity: 0.2, dependencyRisk: 0.1, estimatedHours: 3 };

    expect(classifyIssue({ ...otherwiseEasy, clarity: 0.7 })).toBe("easy_win");
    expect(classifyIssue({ ...otherwiseEasy, clarity: 0.6999 })).toBe("long_term");
  });

  it("preserves complete evidence records in score explanations", () => {
    const evidence = [{
      id: "evidence-1",
      sourceUrl: "https://github.com/example/project/actions",
      retrievedAt: "2026-08-26T00:00:00Z",
      observation: "The default branch check passed.",
      kind: "direct" as const,
    }];

    expect(explainRepositoryScore({ stars: 1, recentActivity: 1, contributionGuide: true, ciHealthy: true, externalPrAcceptance: 1, topicMatch: 1, maintainerResponse: 1 }, evidence)).toMatchObject({
      evidence,
      weightedContributions: expect.arrayContaining([
        { signal: "ciHealthy", weight: 0.1, value: 1, contribution: 0.1 },
      ]),
    });
  });
});
