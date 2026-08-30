import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { DiscoverRepositories } from "../../application/discover.js";
import type { GithubCatalogPort } from "../../application/ports/github-catalog.js";
import type { IntentClassifierPort } from "../../application/ports/intent-classifier.js";
import { spaces } from "../../domain/discovery.js";
import { repositoryPartSchema } from "./support.js";

const discoveryBodySchema = z.object({ spaces: z.array(z.enum(spaces)).length(1) }).strict();
const conversationMessageSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(500) }).strict();
const classifyBodySchema = z.object({ message: z.string().trim().min(1).max(500), history: z.array(conversationMessageSchema).max(10) }).strict();
const repositoryParamsSchema = z.object({ owner: repositoryPartSchema.max(39), repo: repositoryPartSchema }).strict();

export interface DiscoveryRouteDependencies {
  readonly discover: DiscoverRepositories;
  readonly catalog: GithubCatalogPort;
  readonly intentClassifier: IntentClassifierPort;
}

export function registerDiscoveryRoutes(app: FastifyInstance, dependencies: DiscoveryRouteDependencies): void {
  app.post("/api/discovery/classify", async (request) => {
    const input = classifyBodySchema.parse(request.body);
    return dependencies.intentClassifier.classify(input.message, input.history);
  });

  app.post("/api/discovery/repositories", async (request) => {
    const input = discoveryBodySchema.parse(request.body);
    return { repositories: await dependencies.discover.execute(input.spaces) };
  });

  app.get("/api/discovery/repositories/:owner/:repo/issues", async (request) => {
    const { owner, repo } = repositoryParamsSchema.parse(request.params);
    return { issues: await dependencies.catalog.listIssues(`${owner}/${repo}`) };
  });
}
