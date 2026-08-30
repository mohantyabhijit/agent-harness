import type { IssueCandidate, RepositoryCandidate, Space } from "../../domain/discovery.js";

export interface DiscoverySnapshot {
  readonly verifiedAt: string;
  readonly repositories?: readonly RepositoryCandidate[];
  readonly issues?: readonly IssueCandidate[];
}
export interface DiscoverySnapshotPort {
  readRepositories(space: Space): DiscoverySnapshot | undefined;
  readIssues(repository: string): DiscoverySnapshot | undefined;
  writeRepositories(space: Space, values: readonly RepositoryCandidate[], verifiedAt: string): void;
  writeIssues(repository: string, values: readonly IssueCandidate[], verifiedAt: string): void;
}
