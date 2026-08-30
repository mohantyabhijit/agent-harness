import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { TrueForgeIntentClassifier } from "../adapters/trueforge/intent-classifier.js";
import { ApplicationError } from "../application/errors.js";
import { CreateCampaign, type Clock, type IdGenerator } from "../application/create-campaign.js";
import { FinalizeCampaign } from "../application/finalize-campaign.js";
import { DiscoverRepositories } from "../application/discover.js";
import { ApprovalIssuanceConflict, CampaignIdentityConflict, CampaignVersionConflict, type CampaignStore } from "../application/ports/campaign-store.js";
import type { GithubCatalogPort } from "../application/ports/github-catalog.js";
import { HarnessError, HarnessUnavailable, type HarnessPort } from "../application/ports/harness.js";
import { RunCampaign } from "../application/run-campaign.js";
import { SyncReview } from "../application/sync-review.js";
import { SyncAuthenticatedReview } from "../application/sync-authenticated-review.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerSpaceRoutes } from "./routes/spaces.js";
import { ApiProblem } from "./routes/support.js";
import type { AuthorizationPolicy, Capability } from "./authorization.js";
import type { QodoReviewJobHealth } from "./jobs/qodo-review-job.js";
import type { QodoReviewPort } from "../application/ports/qodo-review.js";
import type { RepairVerifierPort } from "../application/ports/repair-verifier.js";

const emptyQuerySchema = z.object({}).strict();

export interface AppDependencies {
  readonly catalog: GithubCatalogPort;
  readonly store: CampaignStore;
  readonly harness: HarnessPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authorization: AuthorizationPolicy;
  readonly reviewHealth?: () => QodoReviewJobHealth;
  readonly qodoReview?: QodoReviewPort;
  readonly repairVerifier?: RepairVerifierPort;
  readonly requireReviewHealth?: boolean;
  readonly reviewSyncTimeoutMs?: number;
}

export function buildApp(dependencies: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1_024 });
  const discover = new DiscoverRepositories(dependencies.catalog);
  const createCampaign = new CreateCampaign(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids);
  const finalizeCampaign = new FinalizeCampaign(dependencies.store, () => dependencies.clock.now(), () => dependencies.ids.next());
  const runCampaign = new RunCampaign(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids);
  const syncReview = new SyncReview(dependencies.store, dependencies.harness, dependencies.clock, dependencies.ids, dependencies.repairVerifier);
  const qodoReview = dependencies.qodoReview ?? { getReview: async () => { throw new HarnessUnavailable(); } };
  const authenticatedReview = new SyncAuthenticatedReview(dependencies.store, qodoReview, syncReview);

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
  app.get("/api/healthz", async () => {
    const review = dependencies.reviewHealth?.();
    return review?.status === "degraded" ? { status: "degraded", review: { code: review.code ?? "unexpected_failure" } } : { status: "ok" };
  });
  app.get("/api/readyz", async (_request, reply) => {
    const review = dependencies.reviewHealth?.();
    if ((dependencies.requireReviewHealth === true && review === undefined) || review?.status === "degraded") {
      return reply.code(503).send({ status: "not_ready", review: { code: review?.code ?? "unexpected_failure" } });
    }
    return reply.send({ status: "ready" });
  });
  registerSpaceRoutes(app);
  registerDiscoveryRoutes(app, { discover, catalog: dependencies.catalog, intentClassifier: new TrueForgeIntentClassifier(dependencies.harness) });
  registerCampaignRoutes(app, { createCampaign, finalizeCampaign, runCampaign, store: dependencies.store, clock: dependencies.clock });
  registerApprovalRoutes(app, { store: dependencies.store, clock: dependencies.clock, ids: dependencies.ids });
  registerReviewRoutes(app, { syncReview: authenticatedReview, ...(dependencies.reviewSyncTimeoutMs === undefined ? {} : { timeoutMs: dependencies.reviewSyncTimeoutMs }) });
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
