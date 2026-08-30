import type { IssueCandidate, RepositoryCandidate, Space } from "../domain/discovery.js";
import type { GithubCatalogPort } from "./ports/github-catalog.js";
import type { DiscoverySnapshotPort } from "./ports/discovery-snapshot.js";

export interface CachedDiscovery<T> { readonly values: readonly T[]; readonly verifiedAt: string; readonly source: "snapshot" | "live"; readonly refreshing: boolean; }

export class DiscoverySnapshotCache {
  private readonly refreshing = new Set<string>();

  constructor(
    private readonly live: GithubCatalogPort,
    private readonly snapshots: DiscoverySnapshotPort,
    private readonly maxAgeMs = 3_600_000,
    private readonly now = () => Date.now(),
  ) {}

  async warmup(selectedSpaces: readonly Space[]): Promise<void> {
    await Promise.all(selectedSpaces.map(async (space) => {
      try {
        const result = await this.repositories(space);
        await Promise.all(result.values.map((repository) =>
          this.issues(repository.fullName).catch(() => undefined),
        ));
      } catch {
        // Startup warming is best effort. A request with no snapshot still falls back to TrueForge.
      }
    }));
  }

  async repositories(space: Space): Promise<CachedDiscovery<RepositoryCandidate>> {
    const snapshot = this.snapshots.readRepositories(space);
    return this.get(
      `repositories:${space}`,
      snapshot?.repositories,
      snapshot,
      () => this.live.listRepositories([space]),
      (values, verifiedAt) => { this.snapshots.writeRepositories(space, values, verifiedAt); },
    );
  }

  async issues(repository: string): Promise<CachedDiscovery<IssueCandidate>> {
    const snapshot = this.snapshots.readIssues(repository);
    return this.get(
      `issues:${repository.toLowerCase()}`,
      snapshot?.issues,
      snapshot,
      () => this.live.listIssues(repository),
      (values, verifiedAt) => { this.snapshots.writeIssues(repository, values, verifiedAt); },
    );
  }

  private async get<T>(
    key: string,
    values: readonly T[] | undefined,
    snapshot: { readonly verifiedAt: string } | undefined,
    fetch: () => Promise<readonly T[]>,
    save: (values: readonly T[], verifiedAt: string) => void,
  ): Promise<CachedDiscovery<T>> {
    if (values !== undefined && snapshot !== undefined) {
      const stale = this.now() - Date.parse(snapshot.verifiedAt) >= this.maxAgeMs;
      if (stale) this.refresh(key, fetch, save);
      return {
        values,
        verifiedAt: snapshot.verifiedAt,
        source: "snapshot",
        refreshing: stale || this.refreshing.has(key),
      };
    }
    const fresh = await fetch();
    const verifiedAt = new Date(this.now()).toISOString();
    save(fresh, verifiedAt);
    return { values: fresh, verifiedAt, source: "live", refreshing: false };
  }

  private refresh<T>(
    key: string,
    fetch: () => Promise<readonly T[]>,
    save: (values: readonly T[], verifiedAt: string) => void,
  ): void {
    if (this.refreshing.has(key)) return;
    this.refreshing.add(key);
    void fetch()
      .then((values) => { save(values, new Date(this.now()).toISOString()); })
      .catch(() => undefined)
      .finally(() => { this.refreshing.delete(key); });
  }
}
