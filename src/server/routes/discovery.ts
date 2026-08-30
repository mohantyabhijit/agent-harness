import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { DiscoverRepositories } from "../../application/discover.js";
import type { GithubCatalogPort } from "../../application/ports/github-catalog.js";
import type { IntentClassifierPort } from "../../application/ports/intent-classifier.js";
import type { DiscoverySnapshotCache } from "../../application/discovery-snapshot-cache.js";
import { spaces } from "../../domain/discovery.js";
import { repositoryPartSchema } from "./support.js";

const discoveryBodySchema = z.object({ spaces: z.array(z.enum(spaces)).length(1) }).strict();
const conversationMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(500) }).strict();
const classifyBodySchema = z.object({ message: z.string().trim().min(1).max(500), history: z.array(conversationMessageSchema).max(10) }).strict();
const repositoryParamsSchema = z.object({ owner: repositoryPartSchema.max(39), repo: repositoryPartSchema }).strict();

export interface DiscoveryRouteDependencies {
  readonly discover: DiscoverRepositories;
  readonly catalog: GithubCatalogPort;
  readonly cache?: DiscoverySnapshotCache;
  readonly intentClassifier: IntentClassifierPort;
}

export function registerDiscoveryRoutes(app: FastifyInstance, dependencies: DiscoveryRouteDependencies): void {
  app.post("/api/discovery/classify", async (request) => {
    const input = classifyBodySchema.parse(request.body);
    return dependencies.intentClassifier.classify(input.message, input.history);
  });

  app.post("/api/discovery/repositories", async (request) => {
    const input = discoveryBodySchema.parse(request.body);
    const space = input.spaces.at(0);
    if (space === undefined) throw new Error("Select exactly one known category");
    const cached = dependencies.cache === undefined ? undefined : await dependencies.cache.repositories(space);
    return cached === undefined
      ? {
          repositories: await dependencies.discover.execute(input.spaces),
          verifiedAt: new Date().toISOString(),
          source: "live" as const,
          refreshing: false,
        }
      : {
          repositories: dependencies.discover.rank(input.spaces, cached.values),
          verifiedAt: cached.verifiedAt,
          source: cached.source,
          refreshing: cached.refreshing,
        };
  });

  app.get("/api/discovery/repositories/:owner/:repo/issues", async (request) => {
    const { owner, repo } = repositoryParamsSchema.parse(request.params);
    if (dependencies.cache !== undefined) {
      const cached = await dependencies.cache.issues(`${owner}/${repo}`);
      return {
        issues: cached.values,
        verifiedAt: cached.verifiedAt,
        source: cached.source,
        refreshing: cached.refreshing,
      };
    }
    return {
      issues: await dependencies.catalog.listIssues(`${owner}/${repo}`),
      verifiedAt: new Date().toISOString(),
      source: "live" as const,
      refreshing: false,
    };
  });
}
