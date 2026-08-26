import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { HarnessAuthRequired, HarnessExecutionFailed, HarnessOutputInvalid, HarnessUnavailable } from "../adapters/trueforge/harness.js";
import { CreateCampaign, type Clock, type IdGenerator } from "../application/create-campaign.js";
import { DiscoverRepositories } from "../application/discover.js";
import { CampaignIdentityConflict, CampaignVersionConflict, type CampaignStore } from "../application/ports/campaign-store.js";
import type { GithubCatalogPort } from "../application/ports/github-catalog.js";
import type { HarnessPort } from "../application/ports/harness.js";
import { RunCampaign } from "../application/run-campaign.js";
import { SyncReview } from "../application/sync-review.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerSpaceRoutes } from "./routes/spaces.js";
import { ApiProblem } from "./routes/support.js";

const emptyQuerySchema = z.object({}).strict();

export interface AppDependencies {
  readonly catalog: GithubCatalogPort;
  readonly store: CampaignStore;
  readonly harness: HarnessPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1_024 });
  const discover = new DiscoverRepositories(dependencies.catalog);
  const createCampaign = new CreateCampaign(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids);
  const runCampaign = new RunCampaign(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids);
  const syncReview = new SyncReview(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids);

  app.addHook("preValidation", async (request) => {
    emptyQuerySchema.parse(request.query);
  });
  app.setErrorHandler((error, _request, reply) => {
    const problem = mapError(error);
    void reply.code(problem.statusCode).send({ code: problem.code, message: problem.publicMessage });
  });
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({
    code: "not_found",
    message: "Route was not found",
  }));
  app.get("/api/healthz", async () => ({ status: "ok" }));
  registerSpaceRoutes(app);
  registerDiscoveryRoutes(app, { discover, catalog: dependencies.catalog });
  registerCampaignRoutes(app, { createCampaign, runCampaign, store: dependencies.store });
  registerApprovalRoutes(app, { store: dependencies.store, clock: dependencies.clock, ids: dependencies.ids });
  registerReviewRoutes(app, { syncReview });
  return app;
}

function mapError(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof z.ZodError) return new ApiProblem(400, "invalid_request", "Request validation failed");
  if (error instanceof HarnessUnavailable || error instanceof HarnessAuthRequired || error instanceof HarnessExecutionFailed || error instanceof HarnessOutputInvalid) {
    return new ApiProblem(503, "harness_unavailable", "Agent harness is unavailable");
  }
  if (!(error instanceof Error)) return new ApiProblem(500, "internal_error", "Request could not be completed");
  if (/Campaign does not exist/u.test(error.message)) return new ApiProblem(404, "campaign_not_found", "Campaign was not found");
  if (("statusCode" in error && error.statusCode === 400) || /^Invalid (?:external action payload|Qodo review batch|Qodo finding)/u.test(error.message)) {
    return new ApiProblem(400, "invalid_request", "Request validation failed");
  }
  if (error instanceof CampaignVersionConflict || error instanceof CampaignIdentityConflict || /already exists|stale|already synchronized|ambiguous|does not match campaign (?:memory|identity)|current head/i.test(error.message)) {
    return new ApiProblem(409, "campaign_conflict", "Campaign conflicts with current state");
  }
  if (/approval|exact external action/i.test(error.message)) {
    return new ApiProblem(412, "approval_required", "Exact action approval is required");
  }
  if (/transition|cannot run|not awaiting|current state|requires explicit human recovery|lacks a repair completion/i.test(error.message)) {
    return new ApiProblem(422, "invalid_transition", "Campaign transition is not allowed");
  }
  return new ApiProblem(500, "internal_error", "Request could not be completed");
}
