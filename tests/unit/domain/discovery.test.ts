import { describe, expect, it } from "vitest";
import { classifyIssue, scoreRepository } from "../../../src/domain/discovery.js";

describe("discovery scoring", () => {
  it("ranks contribution readiness above stars alone", () => {
    const famousDormant = scoreRepository({ stars: 100_000, recentActivity: 0, contributionGuide: false, ciHealthy: false, externalPrAcceptance: 0, topicMatch: 1, maintainerResponse: 0 });
    const healthy = scoreRepository({ stars: 8_000, recentActivity: 1, contributionGuide: true, ciHealthy: true, externalPrAcceptance: 0.8, topicMatch: 1, maintainerResponse: 0.9 });

    expect(healthy).toBeGreaterThan(famousDormant);
  });

  it("classifies complex multi-area work as long term", () => {
    expect(classifyIssue({ clarity: 0.8, affectedAreas: 4, testComplexity: 0.9, dependencyRisk: 0.7, estimatedHours: 20 })).toBe("long_term");
  });
});
