import type { CampaignStore } from "./ports/campaign-store.js";
import type { HarnessPort } from "./ports/harness.js";
import type { Campaign } from "../domain/campaign.js";
import { isIssueBriefFor } from "../domain/issue-brief.js";
import { ApplicationError } from "./errors.js";

function issueBriefResponseSchema(repository: string, issueNumber: number): Record<string, unknown> {
  const repositoryPattern = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return {
    type: "object",
    additionalProperties: false,
    required: ["problem", "likelyCause", "smallestFix", "affectedAreas", "tests", "risks", "uncertainty", "evidence"],
    properties: {
      problem: { type: "string", minLength: 3, maxLength: 2_000 },
      likelyCause: { type: "string", minLength: 3, maxLength: 2_000 },
      smallestFix: { type: "string", minLength: 3, maxLength: 2_000 },
      affectedAreas: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 3, maxLength: 2_000 } },
      tests: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 3, maxLength: 2_000 } },
      risks: { type: "array", minItems: 1, maxItems: 50, items: { type: "string", minLength: 3, maxLength: 2_000 } },
      uncertainty: { type: "string", minLength: 3, maxLength: 2_000 },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sourceUrl", "observation"],
          properties: {
            sourceUrl: {
              type: "string",
              format: "uri",
              pattern: `^https://github\\.com/${repositoryPattern}/(?:issues/${String(issueNumber)}(?:#issuecomment-\\d+)?|pull/\\d+|commit/[0-9a-fA-F]{40}|blob/[^/]+/.+)$`,
            },
            observation: { type: "string", minLength: 3, maxLength: 2_000 },
          },
        },
      },
    },
  } as const;
}

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
    let issueBrief;
    try {
      const analysis = await this.harness.runChildSession({
        campaignId,
        repository: input.repository,
        issueNumber: input.issueNumber,
        goal: "Explain the GitHub issue and propose the smallest safe fix. Return the standard TrueForge final envelope with the strict issue brief in its output field. Cite the selected issue; any additional evidence must be a canonical pull request, 40-character commit, or blob URL in the same repository. Do not cite tree, search, homepage, or external URLs.",
        verifiedEvidence: [{ sourceUrl: input.issueUrl, observation: "Selected GitHub issue to analyze before any repository clone or execution." }],
        approvals: [],
        context: { responseSchema: issueBriefResponseSchema(input.repository, input.issueNumber) },
      }, "policy", { sessionLifecycle: "transient", sessionProfile: "policy" });
      if (!isIssueBriefFor(analysis.output, input.repository, input.issueNumber)) throw new Error("Invalid issue brief");
      issueBrief = structuredClone(analysis.output);
    } catch {
      try {
        await this.harness.deleteSession(parentSessionId);
      } catch {
        throw new Error("Issue analysis failed; unused session cleanup required");
      }
      throw new Error("Issue analysis could not be created");
    }
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
      payload: { status: campaign.status, parentSessionId, issueBrief },
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
