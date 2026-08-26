import type { CampaignStore } from "./ports/campaign-store.js";
import type { HarnessPort } from "./ports/harness.js";
import type { Campaign } from "../domain/campaign.js";
import { ApplicationError } from "./errors.js";

export interface Clock {
  now(): string;
}

export interface IdGenerator {
  next(): string;
}

export interface CreateCampaignInput {
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly lane: Campaign["lane"];
}

export class CreateCampaign {
  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: CreateCampaignInput): Promise<Campaign> {
    validateInput(input);
    let existing;
    try {
      existing = await this.store.findByIssue(input.repository, input.issueNumber);
    } catch {
      throw new Error("Campaign existence could not be checked");
    }
    if (existing) {
      throw new ApplicationError("campaign_conflict");
    }

    const campaignId = requiredValue(this.ids.next(), "campaign identifier");
    const createdAt = requiredValue(this.clock.now(), "campaign timestamp");
    const creationEventId = requiredValue(this.ids.next(), "campaign event identifier");
    const parentSessionId = requiredValue(
      await this.harness.createParentSession(`${input.repository}#${String(input.issueNumber)}`),
      "parent session identifier",
    );
    const campaign: Campaign = {
      id: campaignId,
      repository: input.repository,
      issueNumber: input.issueNumber,
      issueUrl: input.issueUrl,
      parentSessionId,
      lane: input.lane,
      status: "policy_review",
      qodoIteration: 0,
      version: 1,
    };
    const creationEvent = {
      id: creationEventId,
      eventType: "campaign_created",
      payload: { status: campaign.status, parentSessionId },
      occurredAt: createdAt,
    };

    try {
      await this.store.create(campaign, creationEvent);
    } catch {
      try {
        await this.harness.deleteSession(parentSessionId);
      } catch {
        throw new Error("Campaign creation failed; unused session cleanup required");
      }
      let duplicate = false;
      try {
        duplicate = Boolean(await this.store.findByIssue(input.repository, input.issueNumber));
      } catch {
        // The original persistence failure remains authoritative and is exposed
        // only through the fixed, non-secret error below.
      }
      if (duplicate) {
        throw new ApplicationError("campaign_conflict");
      }
      throw new Error("Campaign could not be created");
    }

    return campaign;
  }
}

function validateInput(input: CreateCampaignInput): void {
  if (
    input.repository.trim().length === 0 ||
    !Number.isSafeInteger(input.issueNumber) ||
    input.issueNumber < 1 ||
    input.issueUrl.trim().length === 0
  ) {
    throw new Error("Invalid campaign input");
  }
}

function requiredValue(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
