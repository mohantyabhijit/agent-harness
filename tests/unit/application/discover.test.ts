import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiscoverRepositories } from "../../../src/application/discover.js";
import type { GithubCatalogPort } from "../../../src/application/ports/github-catalog.js";
import { classifyIssue, type IssueCandidate, type RepositoryCandidate, type Space } from "../../../src/domain/discovery.js";

const repositories = JSON.parse(
  readFileSync("fixtures/catalog/repositories.json", "utf8"),
) as readonly RepositoryCandidate[];
const issues = JSON.parse(
  readFileSync("fixtures/catalog/issues.json", "utf8"),
) as readonly IssueCandidate[];

class FixtureCatalog implements GithubCatalogPort {
  readonly requestedSpaces: Space[] = [];

  async listRepositories(selectedSpaces: readonly Space[]): Promise<readonly RepositoryCandidate[]> {
    this.requestedSpaces.push(...selectedSpaces);
    return repositories.filter((repository) =>
      repository.spaces.some((space) => selectedSpaces.includes(space)),
    );
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

  it("normalizes duplicate selected spaces in first-seen order before asking the catalog", async () => {
    const catalog = new FixtureCatalog();

    await new DiscoverRepositories(catalog).execute(["web", "developer_tools", "web"]);

    expect(catalog.requestedSpaces).toEqual(["web", "developer_tools"]);
  });

  it("returns only active, licensed public repositories overlapping a web-only selection", async () => {
    const result = await new DiscoverRepositories(new FixtureCatalog()).execute(["web"]);

    expect(result.map((item) => item.repository.fullName)).toEqual([
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
        evidence: repositories[1]?.evidence,
      },
    });
    expect(healthy?.explanation.weightedContributions).toHaveLength(7);
  });

  it("fails closed for private and malformed visibility records from the adapter", async () => {
    const privateRepository = repositories.find((repository) => repository.fullName === "private/internal-tool");
    const healthyRepository = repositories[1];
    if (!privateRepository || !healthyRepository) throw new Error("Catalog fixture is incomplete");
    const missingVisibility = Object.fromEntries(
      Object.entries(healthyRepository).filter(([key]) => key !== "isPublic"),
    ) as Omit<RepositoryCandidate, "isPublic">;
    const catalog: GithubCatalogPort = {
      async listRepositories(): Promise<readonly RepositoryCandidate[]> {
        // The cast is deliberately limited to the untrusted adapter seam: checked-in fixtures remain contract-valid.
        return [privateRepository, missingVisibility as unknown as RepositoryCandidate];
      },
      async listIssues(): Promise<readonly IssueCandidate[]> {
        return [];
      },
    };

    await expect(new DiscoverRepositories(catalog).execute(["developer_tools"])).resolves.toEqual([]);
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
