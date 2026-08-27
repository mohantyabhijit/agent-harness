import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { DiscoverRepositories } from "../../application/discover.js";
import type { GithubCatalogPort } from "../../application/ports/github-catalog.js";
import { spaces } from "../../domain/discovery.js";
import { repositoryPartSchema } from "./support.js";

const discoveryBodySchema = z.object({ spaces: z.array(z.enum(spaces)).min(1).max(spaces.length) }).strict();
const repositoryParamsSchema = z.object({ owner: repositoryPartSchema.max(39), repo: repositoryPartSchema }).strict();

export interface DiscoveryRouteDependencies {
  readonly discover: DiscoverRepositories;
  readonly catalog: GithubCatalogPort;
}

export function registerDiscoveryRoutes(app: FastifyInstance, dependencies: DiscoveryRouteDependencies): void {
  app.post("/api/discovery/repositories", async (request) => {
    const input = discoveryBodySchema.parse(request.body);
    return { repositories: await dependencies.discover.execute(input.spaces) };
  });

  app.get("/api/discovery/repositories/:owner/:repo/issues", async (request) => {
    const { owner, repo } = repositoryParamsSchema.parse(request.params);
    return { issues: await dependencies.catalog.listIssues(`${owner}/${repo}`) };
  });
}
