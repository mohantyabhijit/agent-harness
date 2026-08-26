import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiscoverRepositories } from "../../../src/application/discover.js";
import type { GithubCatalogPort } from "../../../src/application/ports/github-catalog.js";
import { classifyIssue, type IssueCandidate, type RepositoryCandidate } from "../../../src/domain/discovery.js";

const repositories = JSON.parse(
  readFileSync("fixtures/catalog/repositories.json", "utf8"),
) as readonly RepositoryCandidate[];
const issues = JSON.parse(
  readFileSync("fixtures/catalog/issues.json", "utf8"),
) as readonly IssueCandidate[];

class FixtureCatalog implements GithubCatalogPort {
  async listRepositories(): Promise<readonly RepositoryCandidate[]> {
    return [...repositories].reverse();
  }

  async listIssues(repository: string): Promise<readonly IssueCandidate[]> {
    return issues.filter((issue) => issue.repository === repository);
  }
}

describe("DiscoverRepositories", () => {
  it("filters inactive and unlicensed repositories, then sorts scores deterministically", async () => {
    const result = await new DiscoverRepositories(new FixtureCatalog()).execute(["developer_tools"]);

    expect(result.map((item) => item.repository.fullName)).toEqual([
      "community/same-score",
      "friendly/healthy-contributor",
    ]);
  });

  it("returns source-backed score explanations without making network calls", async () => {
    const result = await new DiscoverRepositories(new FixtureCatalog()).execute(["developer_tools"]);
    const healthy = result.find((item) => item.repository.fullName === "friendly/healthy-contributor");

    expect(healthy).toMatchObject({
      score: expect.any(Number),
      explanation: {
        inputSignals: repositories[1]?.signals,
        sourceUrls: [
          "https://github.com/friendly/healthy-contributor/blob/main/CONTRIBUTING.md",
          "https://github.com/friendly/healthy-contributor/pulls?q=is%3Apr+is%3Aclosed",
        ],
        retrievedAt: ["2026-08-26T00:00:00Z", "2026-08-26T00:01:00Z"],
      },
    });
    expect(healthy?.explanation.weightedContributions).toHaveLength(7);
  });

  it("rejects an empty or unknown space selection", async () => {
    const discovery = new DiscoverRepositories(new FixtureCatalog());

    await expect(discovery.execute([])).rejects.toThrow(/at least one known space/i);
    await expect(discovery.execute(["unknown" as never])).rejects.toThrow(/at least one known space/i);
  });

  it("keeps easy wins and long-term challenges in separate deterministic lanes", async () => {
    const catalog = new FixtureCatalog();
    const fixtureIssues = await catalog.listIssues("friendly/healthy-contributor");

    expect(fixtureIssues.map(classifyIssue)).toEqual(["easy_win", "long_term"]);
  });
});
