import {
  explainRepositoryScore,
  hasValidRepositoryVerification,
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
  constructor(
    private readonly catalog: GithubCatalogPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(selectedSpaces: readonly Space[]): Promise<readonly DiscoveredRepository[]> {
    if (selectedSpaces.length !== 1 || selectedSpaces.some((space) => !isKnownSpace(space))) {
      throw new Error("Select exactly one known category");
    }

    const repositories = await this.catalog.listRepositories(selectedSpaces);
    const referenceTime = this.clock();
    const bestByRepository = new Map<string, DiscoveredRepository>();
    for (const repository of repositories
      .filter((repository) => isDiscoverable(repository, referenceTime))
      .map((repository) => ({
        repository,
        score: scoreRepository(repository.signals),
        explanation: explainRepositoryScore(repository.signals, repository.evidence),
      }))) {
      const identity = repository.repository.fullName.toLowerCase();
      const current = bestByRepository.get(identity);
      if (current === undefined || repository.score > current.score ||
        (repository.score === current.score && repository.repository.fullName.localeCompare(current.repository.fullName) < 0)) {
        bestByRepository.set(identity, repository);
      }
    }

    return [...bestByRepository.values()]
      .sort((left, right) =>
        right.score - left.score || left.repository.fullName.localeCompare(right.repository.fullName),
      )
      .slice(0, 8);
  }
}

function isDiscoverable(repository: RepositoryCandidate, referenceTime: Date): boolean {
  // Catalog adapters are untrusted at runtime; only an explicit true is public.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
  return repository.isPublic === true &&
    repository.signals.recentActivity > 0 &&
    repository.signals.contributionGuide &&
    repository.signals.externalPrAcceptance > 0 &&
    hasValidRepositoryVerification(repository, referenceTime) &&
    repository.fullName.toLowerCase() !== "openai/codex";
}
