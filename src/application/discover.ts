import {
  explainRepositoryScore,
  scoreRepository,
  spaces,
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
    if (selectedSpaces.length === 0 || selectedSpaces.some((space) => !isKnownSpace(space))) {
      throw new Error("Select at least one known space");
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
      );
  }
}

function isKnownSpace(value: string): value is Space {
  return (spaces as readonly string[]).includes(value);
}

function isDiscoverable(repository: RepositoryCandidate): boolean {
  return repository.isPublic !== false && repository.license !== null && repository.signals.recentActivity > 0;
}
