import { ApplicationError } from "./errors.js";
import type { CampaignStore } from "./ports/campaign-store.js";
import { isIssueBriefFor } from "../domain/issue-brief.js";

export interface FinalizeCampaignInput { readonly campaignId: string; readonly expectedVersion: number; readonly idempotencyKey: string; }

export class FinalizeCampaign {
  constructor(private readonly store: CampaignStore, private readonly clock: () => string, private readonly ids: () => string) {}
  async execute(input: FinalizeCampaignInput) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 128) throw new ApplicationError("invalid_request");
    const snapshot = await this.store.get(input.campaignId);
    if (snapshot === undefined) throw new ApplicationError("campaign_not_found");
    const prior = snapshot.events.find((event) => event.eventType === "campaign_finalized" && isRecord(event.payload) && event.payload.idempotencyKey === input.idempotencyKey);
    if (prior !== undefined) {
      if (!isRecord(prior.payload) || prior.payload.expectedVersion !== input.expectedVersion) throw new ApplicationError("campaign_conflict");
      return snapshot.campaign;
    }
    if (snapshot.campaign.version !== input.expectedVersion || snapshot.campaign.status !== "policy_review") throw new ApplicationError("campaign_conflict");
    const creation = snapshot.events.find((event) => event.eventType === "campaign_created" && isRecord(event.payload) && isIssueBriefFor(event.payload.issueBrief, snapshot.campaign.repository, snapshot.campaign.issueNumber));
    const brief = creation !== undefined && isRecord(creation.payload) ? creation.payload.issueBrief : undefined;
    if (!isIssueBriefFor(brief, snapshot.campaign.repository, snapshot.campaign.issueNumber)) throw new ApplicationError("invalid_request");
    return this.store.finalizeCampaign(input.campaignId, brief, input.expectedVersion, { id: this.ids(), eventType: "campaign_finalized", occurredAt: this.clock(), payload: { idempotencyKey: input.idempotencyKey, expectedVersion: input.expectedVersion } });
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
