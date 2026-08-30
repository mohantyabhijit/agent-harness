import {
  explainRepositoryScore,
  isKnownSpace,
  scoreRepository,
  type RepositoryCandidate,
  type RepositoryScoreExplanation,
  type Space,
} from "../domain/discovery.js";
import type { GithubCatalogPort } from "./ports/github-catalog.js";

export interface DiscoveredRepository {
  readonly repository: RepositoryCandidate;
  readonly score: number;
  readonly explanation: RepositoryScoreExplanation;
}

export class DiscoverRepositories {
  constructor(private readonly catalog: GithubCatalogPort) {}

  async execute(selectedSpaces: readonly Space[]): Promise<readonly DiscoveredRepository[]> {
    if (selectedSpaces.length !== 1 || selectedSpaces.some((space) => !isKnownSpace(space))) {
      throw new Error("Select exactly one known category");
    }

    const repositories = await this.catalog.listRepositories(selectedSpaces);
    return repositories
      .filter(isDiscoverable)
      .map((repository) => ({
        repository,
        score: scoreRepository(repository.signals),
        explanation: explainRepositoryScore(repository.signals, repository.evidence),
      }))
      .sort((left, right) =>
        right.score - left.score || left.repository.fullName.localeCompare(right.repository.fullName),
      )
      .slice(0, 8);
  }
}

function isDiscoverable(repository: RepositoryCandidate): boolean {
  // Catalog adapters are untrusted at runtime; only an explicit true is public.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
  return repository.isPublic === true &&
    repository.license !== null &&
    repository.signals.recentActivity > 0 &&
    repository.signals.contributionGuide &&
    repository.signals.externalPrAcceptance > 0 &&
    repository.fullName.toLowerCase() !== "openai/codex";
}
