import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiscoverRepositories } from "../../../src/application/discover.js";
import type { GithubCatalogPort } from "../../../src/application/ports/github-catalog.js";
import { classifyIssue, spaces, type IssueCandidate, type RepositoryCandidate, type RepositoryVerificationEvidence, type Space } from "../../../src/domain/discovery.js";

const repositories = (JSON.parse(
  readFileSync("fixtures/catalog/repositories.json", "utf8"),
) as readonly RepositoryCandidate[]).map(withVerificationEvidence);
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
  it("exposes exactly the five prospective repository categories", () => {
    expect(spaces).toEqual([
      "ai_ml",
      "developer_tools",
      "web",
      "data",
      "social_impact",
    ]);
  });

  it("filters inactive and unlicensed repositories, then sorts scores deterministically", async () => {
    const result = await createDiscovery(new FixtureCatalog()).execute(["developer_tools"]);

    expect(result.map((item) => item.repository.fullName)).toEqual([
      "community/same-score",
      "friendly/healthy-contributor",
    ]);
  });

  it("returns only active, licensed public repositories overlapping a web-only selection", async () => {
    const result = await createDiscovery(new FixtureCatalog()).execute(["web"]);

    expect(result.map((item) => item.repository.fullName)).toEqual([
      "friendly/healthy-contributor",
    ]);
  });

  it("returns source-backed score explanations without making network calls", async () => {
    const result = await createDiscovery(new FixtureCatalog()).execute(["developer_tools"]);
    const healthy = result.find((item) => item.repository.fullName === "friendly/healthy-contributor");

    expect(healthy).toMatchObject({
      score: expect.any(Number),
      explanation: {
        inputSignals: repositories[1]?.signals,
        sourceUrls: [
          "https://github.com/friendly/healthy-contributor",
          "https://github.com/friendly/healthy-contributor/blob/main/LICENSE",
          `https://github.com/friendly/healthy-contributor/commit/${"a".repeat(40)}`,
          "https://github.com/friendly/healthy-contributor/blob/main/CONTRIBUTING.md",
          "https://github.com/friendly/healthy-contributor/pull/42",
        ],
        retrievedAt: Array(5).fill("2026-08-26T11:55:00Z"),
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

    await expect(createDiscovery(catalog).execute(["developer_tools"])).resolves.toEqual([]);
  });

  it("fails closed when contribution guidance or accepted external pull requests are unverified", async () => {
    const base = repositories[1];
    if (base === undefined) throw new Error("Catalog fixture is incomplete");
    const catalog: GithubCatalogPort = {
      async listRepositories() {
        return [
          { ...base, fullName: "unready/no-guide", signals: { ...base.signals, contributionGuide: false } },
          { ...base, fullName: "unready/no-external-prs", signals: { ...base.signals, externalPrAcceptance: 0 } },
          { ...base, fullName: "openai/codex" },
        ];
      },
      async listIssues() { return []; },
    };

    await expect(createDiscovery(catalog).execute(["developer_tools"])).resolves.toEqual([]);
  });

  it.each([
    ["visibility"],
    ["license"],
    ["recent_activity"],
    ["contribution_policy"],
    ["external_pr_acceptance"],
  ])("fails closed without direct %s evidence", async (claim) => {
    const base = repositories[1];
    if (base === undefined) throw new Error("Catalog fixture is incomplete");
    const catalog: GithubCatalogPort = {
      async listRepositories() {
        return [{
          ...base,
          evidence: base.evidence.map((entry) =>
            "claim" in entry && entry.claim === claim ? { ...entry, kind: "inference" as const } : entry,
          ) as unknown as RepositoryCandidate["evidence"],
        }];
      },
      async listIssues() { return []; },
    };

    await expect(createDiscovery(catalog).execute(["developer_tools"])).resolves.toEqual([]);
  });

  it("fails closed when generic direct evidence is substituted for claim-specific records", async () => {
    const base = repositories[1];
    if (base === undefined) throw new Error("Catalog fixture is incomplete");
    const genericEvidence = base.evidence.map((entry) => {
      return Object.fromEntries(
        Object.entries(entry).filter(([key]) => key !== "claim" && key !== "verifiedValue"),
      ) as unknown as RepositoryCandidate["evidence"][number];
    });
    const catalog: GithubCatalogPort = {
      async listRepositories() {
        return [{ ...base, evidence: genericEvidence }];
      },
      async listIssues() { return []; },
    };

    await expect(createDiscovery(catalog).execute(["developer_tools"])).resolves.toEqual([]);
  });

  it("rejects empty, multiple, unknown, and retired category selections", async () => {
    const discovery = createDiscovery(new FixtureCatalog());

    await expect(discovery.execute([])).rejects.toThrow(/one known category/i);
    await expect(discovery.execute(["web", "developer_tools"])).rejects.toThrow(/one known category/i);
    await expect(discovery.execute(["unknown" as never])).rejects.toThrow(/one known category/i);
    await expect(discovery.execute(["mobile" as never])).rejects.toThrow(/one known category/i);
  });

  it("returns at most eight repositories in deterministic score order", async () => {
    const base = repositories[1];
    if (base === undefined) throw new Error("Catalog fixture is incomplete");
    const candidates = Array.from({ length: 10 }, (_, index): RepositoryCandidate => {
      const candidate = repositoryForName(
        base,
        `popular/repository-${String(index).padStart(2, "0")}`,
        1_000 + index,
      );
      return {
        ...candidate,
        signals: { ...candidate.signals, maintainerResponse: (index + 1) / 10 },
      };
    });
    const catalog: GithubCatalogPort = {
      async listRepositories() { return candidates; },
      async listIssues() { return []; },
    };

    const result = await createDiscovery(catalog).execute(["developer_tools"]);

    expect(result).toHaveLength(8);
    expect(result.map(({ repository }) => repository.fullName)).toEqual([
      "popular/repository-09",
      "popular/repository-08",
      "popular/repository-07",
      "popular/repository-06",
      "popular/repository-05",
      "popular/repository-04",
      "popular/repository-03",
      "popular/repository-02",
    ]);
  });

  it("deduplicates repository names case-insensitively before applying the eight-result limit", async () => {
    const base = repositories[1];
    if (base === undefined) throw new Error("Catalog fixture is incomplete");
    const unique = Array.from({ length: 8 }, (_, index) => repositoryForName(
      base,
      `popular/repository-${String(index)}`,
      2_000 - index,
    ));
    const duplicate = repositoryForName(base, "POPULAR/REPOSITORY-0", 3_000);
    const first = unique[0];
    if (first === undefined) throw new Error("Expected a generated repository");
    const catalog: GithubCatalogPort = {
      async listRepositories() { return [first, duplicate, ...unique.slice(1)]; },
      async listIssues() { return []; },
    };

    const result = await createDiscovery(catalog).execute(["developer_tools"]);

    expect(result).toHaveLength(8);
    expect(result.filter(({ repository }) => repository.fullName.toLowerCase() === "popular/repository-0")).toHaveLength(1);
    expect(result.some(({ repository }) => repository.fullName === duplicate.fullName)).toBe(true);
  });

  it("keeps easy wins and long-term challenges in separate deterministic lanes", async () => {
    const catalog = new FixtureCatalog();
    const fixtureIssues = await catalog.listIssues("friendly/healthy-contributor");

    expect(fixtureIssues.map(classifyIssue)).toEqual(["easy_win", "long_term"]);
  });
});

function withVerificationEvidence(repository: RepositoryCandidate): RepositoryCandidate {
  const source = repository.url;
  return {
    ...repository,
    evidence: [
      verificationEvidence("visibility", source, { visibility: "public" }),
      verificationEvidence("license", `${source}/blob/main/LICENSE`, { spdxId: repository.license, path: "LICENSE" }),
      verificationEvidence("recent_activity", `${source}/commit/${"a".repeat(40)}`, { commitSha: "a".repeat(40), committedAt: "2026-08-25T00:00:00Z" }),
      verificationEvidence("contribution_policy", `${source}/blob/main/CONTRIBUTING.md`, { path: "CONTRIBUTING.md" }),
      verificationEvidence("external_pr_acceptance", `${source}/pull/42`, { pullRequestNumber: 42, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "CONTRIBUTOR" }),
    ],
  };
}

function verificationEvidence(
  claim: "visibility" | "license" | "recent_activity" | "contribution_policy" | "external_pr_acceptance",
  sourceUrl: string,
  verifiedValue: Readonly<Record<string, unknown>>,
): RepositoryVerificationEvidence {
  return {
    id: `verification-${claim}`,
    sourceUrl,
    retrievedAt: "2026-08-26T11:55:00Z",
    observation: `${claim} verified directly on GitHub.`,
    kind: "direct" as const,
    claim,
    verifiedValue,
  } as RepositoryVerificationEvidence;
}

const referenceClock = (): Date => new Date("2026-08-26T12:00:00Z");

function createDiscovery(catalog: GithubCatalogPort): DiscoverRepositories {
  return new DiscoverRepositories(catalog, referenceClock);
}

function repositoryForName(
  base: RepositoryCandidate,
  fullName: string,
  stars: number,
): RepositoryCandidate {
  const url = `https://github.com/${fullName}`;
  return withVerificationEvidence({
    ...base,
    fullName,
    url,
    signals: { ...base.signals, stars },
  });
}
