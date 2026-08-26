import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { ApplicationError } from "../application/errors.js";
import { CreateCampaign, type Clock, type IdGenerator } from "../application/create-campaign.js";
import { DiscoverRepositories } from "../application/discover.js";
import { ApprovalIssuanceConflict, CampaignIdentityConflict, CampaignVersionConflict, type CampaignStore } from "../application/ports/campaign-store.js";
import type { GithubCatalogPort } from "../application/ports/github-catalog.js";
import { HarnessError, type HarnessPort } from "../application/ports/harness.js";
import { RunCampaign } from "../application/run-campaign.js";
import { SyncReview } from "../application/sync-review.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerSpaceRoutes } from "./routes/spaces.js";
import { ApiProblem } from "./routes/support.js";
import type { AuthorizationPolicy, Capability } from "./authorization.js";

const emptyQuerySchema = z.object({}).strict();

export interface AppDependencies {
  readonly catalog: GithubCatalogPort;
  readonly store: CampaignStore;
  readonly harness: HarnessPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authorization: AuthorizationPolicy;
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
  app.addHook("onRequest", async (request) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    const routeConfig = request.routeOptions.config as { capability?: Capability };
    dependencies.authorization.require(request, routeConfig.capability ?? "operator");
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
  if (error instanceof HarnessError) {
    return new ApiProblem(503, "harness_unavailable", "Agent harness is unavailable");
  }
  if (error instanceof ApplicationError) {
    const mapped = {
      campaign_not_found: [404, "campaign_not_found", "Campaign was not found"],
      campaign_conflict: [409, "campaign_conflict", "Campaign conflicts with current state"],
      approval_required: [412, "approval_required", "Exact action approval is required"],
      invalid_transition: [422, "invalid_transition", "Campaign transition is not allowed"],
      invalid_request: [400, "invalid_request", "Request validation failed"],
    } as const;
    const [status, code, message] = mapped[error.code];
    return new ApiProblem(status, code, message);
  }
  if (!(error instanceof Error)) return new ApiProblem(500, "internal_error", "Request could not be completed");
  if (("statusCode" in error && error.statusCode === 400) || ("code" in error && ["FST_ERR_CTP_BODY_TOO_LARGE", "FST_ERR_CTP_INVALID_MEDIA_TYPE", "FST_ERR_CTP_EMPTY_JSON_BODY"].includes(String(error.code)))) {
    return new ApiProblem(400, "invalid_request", "Request validation failed");
  }
  if (error instanceof CampaignVersionConflict || error instanceof CampaignIdentityConflict || error instanceof ApprovalIssuanceConflict) {
    return new ApiProblem(409, "campaign_conflict", "Campaign conflicts with current state");
  }
  return new ApiProblem(500, "internal_error", "Request could not be completed");
}
