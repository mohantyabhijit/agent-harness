import type { IssueCandidate, RepositoryCandidate, Space } from "../../domain/discovery.js";

export interface GithubCatalogPort {
  listRepositories(spaces: readonly Space[]): Promise<readonly RepositoryCandidate[]>;
  listIssues(repository: string): Promise<readonly IssueCandidate[]>;
}
