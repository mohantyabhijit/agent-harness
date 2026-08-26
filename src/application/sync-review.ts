import { transitionCampaign, type Campaign } from "../domain/campaign.js";
import {
  evaluateQualityGate,
  type QodoFinding,
  type QualityGateResult,
} from "../domain/quality-gate.js";
import type { Clock, IdGenerator } from "./create-campaign.js";
import type { CampaignEventInput, CampaignSnapshot, CampaignStore } from "./ports/campaign-store.js";
import type { CampaignPacket, HarnessPort } from "./ports/harness.js";
import { isPullRequest } from "./external-action.js";
import { parseQodoReviewBatch, type QodoReviewBatch } from "./qodo-review-batch.js";
import { ApplicationError } from "./errors.js";
import type { HarnessRequestOptions } from "./ports/harness.js";

export type { QodoReviewBatch } from "./qodo-review-batch.js";

interface ClaimedReview {
  readonly campaign: Campaign;
  readonly gate: QualityGateResult;
}

export class SyncReview {
  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(campaignId: string, input: QodoReviewBatch, context?: HarnessRequestOptions): Promise<Campaign> {
    const batch = parseQodoReviewBatch(input);
    if (batch.campaignId !== campaignId) {
      throw new ApplicationError("campaign_conflict");
    }
    const snapshot = await this.requiredSnapshot(campaignId);
    if (snapshot.campaign.status !== "qodo_review") {
      throw new ApplicationError("invalid_transition");
    }
    assertReviewIsCurrent(snapshot, batch);

    const combinedFindings = mergeFindings(snapshot.qodoFindings, batch.findings);
    const gate = evaluateQualityGate({
      testsPassed: batch.testsPassed && batch.complete,
      iteration: snapshot.campaign.qodoIteration,
      findings: combinedFindings,
    });
    const claimed = claimReview(snapshot.campaign, gate);
    await this.store.update(claimed.campaign, snapshot.campaign.version);
    await this.appendReviewEvent(claimed.campaign, "qodo_review_claimed", batch, {
      outcome: gate.outcome,
      reviewIteration: snapshot.campaign.qodoIteration,
      findings: batch.findings,
    });

    const findingIteration = Math.max(1, claimed.campaign.qodoIteration);
    for (const finding of batch.findings) {
      await this.store.recordQodoFinding(campaignId, findingIteration, finding);
      await this.appendReviewEvent(claimed.campaign, "qodo_finding_recorded", batch, {
        iteration: findingIteration,
        finding,
      });
    }

    if (gate.outcome === "pass") {
      await this.appendReviewEvent(claimed.campaign, "quality_gate_passed", batch, {
        iteration: claimed.campaign.qodoIteration,
      });
      return claimed.campaign;
    }
    if (gate.outcome === "escalate") {
      await this.appendReviewEvent(claimed.campaign, "quality_gate_escalated", batch, {
        iteration: snapshot.campaign.qodoIteration,
        reason: gate.reason,
      });
      return claimed.campaign;
    }

    await this.appendReviewEvent(claimed.campaign, "quality_gate_repair_requested", batch, {
      iteration: gate.nextIteration,
    });
    try {
      const result = await this.harness.runChildSession(
        this.repairPacket(snapshot, claimed.campaign, batch, combinedFindings),
        "repair",
        context,
      );
      const nextCommitSha = repairCommit(result.output);
      const resultingVersion = claimed.campaign.version + (nextCommitSha !== undefined && nextCommitSha !== batch.commitSha ? 1 : 0);
      if (isCancelled(context)) return claimed.campaign;
      const recordedVersion = await this.store.recordChildResult(campaignId, {
        expectedVersion: claimed.campaign.version,
        expectedStatus: "repair",
        childSessionId: result.sessionId,
        event: this.reviewEvent(claimed.campaign, "campaign_operation_completed", batch, {
          operation: "repair",
          iteration: gate.nextIteration,
          childSessionId: result.sessionId,
          sandboxSessionId: result.sessionId,
          artifacts: result.artifacts,
          summary: result.summary,
          output: result.output,
          resultingCampaignVersion: resultingVersion,
        }),
        ...(nextCommitSha === undefined ? {} : { newCommitSha: nextCommitSha }),
        operationResult: {
          operation: "repair",
          currentCommitSha: nextCommitSha ?? batch.commitSha,
          pullRequest: batch.pullRequest,
          qodoIteration: claimed.campaign.qodoIteration,
        },
      });
      return { ...claimed.campaign, version: recordedVersion };
    } catch {
      try {
        const escalated = transitionCampaign(claimed.campaign, "human_escalation");
        if (isCancelled(context)) return claimed.campaign;
        await this.store.update(escalated, claimed.campaign.version);
        if (isCancelled(context)) return escalated;
        await this.appendReviewEvent(claimed.campaign, "repair_execution_failed", batch, { reason: "repair_child_failed" });
        return escalated;
      } catch (recoveryError) {
        if (isCancelled(context)) return claimed.campaign;
        throw new Error("Repair result was fenced by campaign recovery", { cause: recoveryError });
      }
    }
  }

  private repairPacket(
    snapshot: CampaignSnapshot,
    claimedCampaign: Campaign,
    batch: QodoReviewBatch,
    findings: readonly QodoFinding[],
  ): CampaignPacket {
    const unresolvedFindings = findings.filter(
      ({ status, disposition }) =>
        status === "open" || (status !== "fixed" && !disposition?.trim()),
    );
    return {
      campaignId: snapshot.campaign.id,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      goal: `Repair validated Qodo findings for iteration ${String(claimedCampaign.qodoIteration)}`,
      verifiedEvidence: snapshot.evidence
        .filter(({ kind }) => kind === "direct")
        .map(({ sourceUrl, observation }) => ({ sourceUrl, observation })),
      approvals: snapshot.approvals.map(({ action, actionDigest, status }) => ({
        action,
        digest: actionDigest,
        status,
      })),
      currentCommitSha: batch.commitSha,
      context: {
        pullRequest: batch.pullRequest,
        reviewId: batch.reviewId,
        commitSha: batch.commitSha,
        testsPassed: batch.testsPassed,
        complete: batch.complete,
        iteration: claimedCampaign.qodoIteration,
        unresolvedFindings,
      },
    };
  }

  private async appendReviewEvent(
    claimedCampaign: Campaign,
    eventType: string,
    batch: QodoReviewBatch,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.store.appendEvent(claimedCampaign.id, this.reviewEvent(claimedCampaign, eventType, batch, payload));
  }

  private reviewEvent(
    claimedCampaign: Campaign,
    eventType: string,
    batch: QodoReviewBatch,
    payload: Readonly<Record<string, unknown>>,
  ): CampaignEventInput {
    return {
      id: this.nextId(),
      eventType,
      payload: {
        pullRequest: batch.pullRequest,
        reviewId: batch.reviewId,
        commitSha: batch.commitSha,
        testsPassed: batch.testsPassed,
        complete: batch.complete,
        claimedCampaignVersion: claimedCampaign.version,
        ...payload,
      },
      occurredAt: this.clock.now(),
    };
  }

  private nextId(): string {
    const id = this.ids.next();
    if (id.trim().length === 0) {
      throw new Error("Invalid campaign event identifier");
    }
    return id;
  }

  private async requiredSnapshot(campaignId: string): Promise<CampaignSnapshot> {
    const snapshot = await this.store.get(campaignId);
    if (snapshot === undefined) {
      throw new ApplicationError("campaign_not_found");
    }
    return snapshot;
  }
}

function claimReview(campaign: Campaign, gate: QualityGateResult): ClaimedReview {
  if (gate.outcome === "repair") {
    return {
      campaign: {
        ...transitionCampaign(campaign, "repair"),
        qodoIteration: gate.nextIteration,
      },
      gate,
    };
  }
  if (gate.outcome === "escalate") {
    return { campaign: transitionCampaign(campaign, "human_escalation"), gate };
  }
  return { campaign: { ...campaign, version: campaign.version + 1 }, gate };
}

function assertReviewIsCurrent(snapshot: CampaignSnapshot, batch: QodoReviewBatch): void {
  if (!isPullRequest(batch.pullRequest, snapshot.campaign.repository)) throw new ApplicationError("campaign_conflict");
  const commitReferences = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
  const currentCommit = commitReferences[0];
  if (commitReferences.length !== 1 || currentCommit === undefined || currentCommit.value !== batch.commitSha) {
    throw new ApplicationError("campaign_conflict");
  }
  const pullRequests = snapshot.externalReferences
    .filter(({ kind }) => kind === "pull_request")
    .map(({ value }) => value);
  if (new Set(pullRequests).size > 1) {
    throw new ApplicationError("campaign_conflict");
  }
  if (pullRequests.length !== 1 || pullRequests[0] !== batch.pullRequest) {
    throw new ApplicationError("campaign_conflict");
  }
  if (snapshot.events.some((event) =>
    event.eventType === "qodo_review_claimed" &&
    isRecord(event.payload) &&
    event.payload.reviewId === batch.reviewId &&
    event.payload.commitSha === batch.commitSha &&
    event.payload.reviewIteration === snapshot.campaign.qodoIteration
  )) {
    throw new ApplicationError("campaign_conflict");
  }
}

function mergeFindings(
  persisted: readonly QodoFinding[],
  incoming: readonly QodoFinding[],
): readonly QodoFinding[] {
  const findings = new Map(persisted.map((finding) => [finding.id, finding]));
  for (const finding of incoming) {
    findings.set(finding.id, finding);
  }
  return [...findings.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairCommit(output: unknown): string | undefined {
  if (!isRecord(output) || output.commitSha === undefined) return undefined;
  if (typeof output.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(output.commitSha)) throw new Error("Invalid repair commit");
  return output.commitSha;
}

function isCancelled(context?: HarnessRequestOptions): boolean {
  return context?.signal?.aborted === true;
}
