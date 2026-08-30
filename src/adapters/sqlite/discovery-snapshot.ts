import type Database from "better-sqlite3";
import { z } from "zod";

import type { DiscoverySnapshot, DiscoverySnapshotPort } from "../../application/ports/discovery-snapshot.js";
import {
  hasValidRepositoryVerification,
  spaces,
  type IssueCandidate,
  type RepositoryCandidate,
  type Space,
} from "../../domain/discovery.js";
import { migrateCampaignStore } from "./migrate.js";

const score = z.number().min(0).max(1);
const repositoryName = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const issueSchema = z.object({
  repository: repositoryName,
  number: z.number().int().positive().refine(Number.isSafeInteger),
  title: z.string().trim().min(1),
  url: z.url(),
  clarity: score,
  affectedAreas: z.number().int().nonnegative().refine(Number.isSafeInteger),
  testComplexity: score,
  dependencyRisk: score,
  estimatedHours: z.number().nonnegative(),
  maintainerSignals: z.array(z.string().trim().min(1)),
}).strict();
const repositoryShape = z.object({
  fullName: repositoryName,
  url: z.url(),
  description: z.string(),
  spaces: z.array(z.enum(spaces)).min(1),
  license: z.string().trim().min(1),
  isPublic: z.literal(true),
  signals: z.object({
    stars: z.number().int().nonnegative().refine(Number.isSafeInteger),
    recentActivity: score,
    contributionGuide: z.boolean(),
    ciHealthy: z.boolean(),
    externalPrAcceptance: score,
    topicMatch: score,
    maintainerResponse: score,
  }).strict(),
  evidence: z.array(z.unknown()).length(5),
}).strict();

interface SnapshotRow {
  readonly payload_json: string;
  readonly verified_at: string;
  readonly source: string;
}

export class SqliteDiscoverySnapshotStore implements DiscoverySnapshotPort {
  constructor(private readonly database: Database.Database) {
    migrateCampaignStore(database);
  }

  readRepositories(space: Space): DiscoverySnapshot | undefined {
    const row = this.readRow(`repositories:${space}`, "repositories");
    if (row === undefined) return undefined;
    try {
      const repositories = z.array(repositoryShape).max(8).parse(JSON.parse(row.payload_json)) as RepositoryCandidate[];
      const referenceTime = new Date();
      if (!repositories.every((repository) => hasValidRepositoryVerification(repository, referenceTime))) {
        return undefined;
      }
      return { repositories, verifiedAt: row.verified_at };
    } catch {
      return undefined;
    }
  }

  readIssues(repository: string): DiscoverySnapshot | undefined {
    const row = this.readRow(`issues:${repository.toLowerCase()}`, "issues");
    if (row === undefined) return undefined;
    try {
      const issues = z.array(issueSchema).parse(JSON.parse(row.payload_json));
      if (!issues.every((issue) => isIssueForRepository(issue, repository))) {
        return undefined;
      }
      return { issues, verifiedAt: row.verified_at };
    } catch {
      return undefined;
    }
  }

  writeRepositories(
    space: Space,
    values: readonly RepositoryCandidate[],
    verifiedAt: string,
  ): void {
    const referenceTime = validVerificationTime(verifiedAt);
    const repositories = z.array(repositoryShape).max(8).parse(values) as RepositoryCandidate[];
    if (!repositories.every((repository) =>
      repository.spaces.includes(space) && hasValidRepositoryVerification(repository, referenceTime),
    )) {
      throw new Error("Invalid repository snapshot");
    }
    this.write(`repositories:${space}`, "repositories", repositories, verifiedAt);
  }

  writeIssues(repository: string, values: readonly IssueCandidate[], verifiedAt: string): void {
    validVerificationTime(verifiedAt);
    const issues = z.array(issueSchema).parse(values);
    if (!issues.every((issue) => isIssueForRepository(issue, repository))) {
      throw new Error("Invalid issue snapshot");
    }
    this.write(`issues:${repository.toLowerCase()}`, "issues", issues, verifiedAt);
  }

  private readRow(snapshotKey: string, kind: "repositories" | "issues"): SnapshotRow | undefined {
    const row = this.database.prepare(
      "SELECT payload_json, verified_at, source FROM discovery_snapshots WHERE snapshot_key = ? AND kind = ?",
    ).get(snapshotKey, kind) as SnapshotRow | undefined;
    if (row === undefined || row.source !== "live" || !isValidTimestamp(row.verified_at)) return undefined;
    return row;
  }

  private write(
    snapshotKey: string,
    kind: "repositories" | "issues",
    values: readonly unknown[],
    verifiedAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO discovery_snapshots(snapshot_key, kind, payload_json, verified_at, source)
      VALUES (?, ?, ?, ?, 'live')
      ON CONFLICT(snapshot_key) DO UPDATE SET
        kind = excluded.kind,
        payload_json = excluded.payload_json,
        verified_at = excluded.verified_at,
        source = excluded.source
    `).run(snapshotKey, kind, JSON.stringify(values), verifiedAt);
  }
}

function validVerificationTime(value: string): Date {
  const parsed = new Date(value);
  if (!isValidTimestamp(value) || parsed.getTime() > Date.now()) {
    throw new Error("Invalid snapshot verification time");
  }
  return parsed;
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isIssueForRepository(issue: IssueCandidate, repository: string): boolean {
  if (issue.repository.toLowerCase() !== repository.toLowerCase()) return false;
  try {
    const url = new URL(issue.url);
    return url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.toLowerCase() === `/${repository}/issues/${String(issue.number)}`.toLowerCase();
  } catch {
    return false;
  }
}
