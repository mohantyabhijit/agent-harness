import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { CreateCampaign } from "../../application/create-campaign.js";
import type { CampaignStore } from "../../application/ports/campaign-store.js";
import type { RunCampaign } from "../../application/run-campaign.js";
import { ApplicationError } from "../../application/errors.js";
import { CampaignIdentityConflict, CampaignVersionConflict } from "../../application/ports/campaign-store.js";
import { HarnessError } from "../../application/ports/harness.js";
import { boundedUrlSchema, campaignIdSchema, campaignNotFound, issueNumberSchema, publicCampaignSnapshot, repositorySchema } from "./support.js";

const createCampaignSchema = z
  .object({
    repository: repositorySchema,
    issueNumber: issueNumberSchema,
    issueUrl: boundedUrlSchema,
    lane: z.enum(["easy_win", "long_term"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.issueUrl !== `https://github.com/${value.repository}/issues/${String(value.issueNumber)}`) {
      context.addIssue({ code: "custom", message: "Issue URL does not match repository issue" });
    }
  });
const campaignParamsSchema = z.object({ id: campaignIdSchema }).strict();
const actionParamsSchema = z.object({ id: campaignIdSchema, action: z.enum(["preflight", "implement", "verify"]) }).strict();
const emptyBodySchema = z.object({}).strict();

export interface CampaignRouteDependencies {
  readonly createCampaign: CreateCampaign;
  readonly runCampaign: RunCampaign;
  readonly store: CampaignStore;
}

export function registerCampaignRoutes(app: FastifyInstance, dependencies: CampaignRouteDependencies): void {
  app.post("/api/campaigns", async (request, reply) => {
    const input = createCampaignSchema.parse(request.body);
    const created = await dependencies.createCampaign.execute(input);
    return reply.code(201).send(created);
  });

  app.get("/api/campaigns/:id", async (request) => {
    const { id } = campaignParamsSchema.parse(request.params);
    const snapshot = await dependencies.store.get(id);
    if (snapshot === undefined) throw campaignNotFound();
    return publicCampaignSnapshot(snapshot);
  });

  app.post("/api/campaigns/:id/actions/:action", async (request) => {
    const { id, action } = actionParamsSchema.parse(request.params);
    emptyBodySchema.parse(request.body ?? {});
    try {
      return await dependencies.runCampaign.execute(id, action);
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof HarnessError || error instanceof CampaignVersionConflict || error instanceof CampaignIdentityConflict) throw error;
      throw new ApplicationError("invalid_transition");
    }
  });
}
