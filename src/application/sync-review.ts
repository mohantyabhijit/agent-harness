import { transitionCampaign, type Campaign } from "../domain/campaign.js";
import {
  evaluateQualityGate,
  type QodoFinding,
  type QualityGateResult,
} from "../domain/quality-gate.js";
import type { Clock, IdGenerator } from "./create-campaign.js";
import type { CampaignEvent, CampaignSnapshot, CampaignStore } from "./ports/campaign-store.js";
import type { CampaignPacket, HarnessPort } from "./ports/harness.js";
import { isPullRequest } from "./external-action.js";

export interface QodoReviewBatch {
  readonly campaignId: string;
  readonly pullRequest: string;
  readonly reviewId: string;
  readonly commitSha: string;
  readonly testsPassed: boolean;
  readonly complete: boolean;
  readonly findings: readonly QodoFinding[];
}

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

  async execute(campaignId: string, input: QodoReviewBatch): Promise<Campaign> {
    const batch = parseReviewBatch(input);
    if (batch.campaignId !== campaignId) {
      throw new Error("Qodo review campaign does not match requested campaign");
    }
    const snapshot = await this.requiredSnapshot(campaignId);
    if (snapshot.campaign.status !== "qodo_review") {
      throw new Error("Campaign is not awaiting Qodo review");
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
      );
      const nextCommitSha = repairCommit(result.output);
      const resultingVersion = claimed.campaign.version + (nextCommitSha !== undefined && nextCommitSha !== batch.commitSha ? 1 : 0);
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
      });
      return { ...claimed.campaign, version: recordedVersion };
    } catch {
      try {
        const escalated = transitionCampaign(claimed.campaign, "human_escalation");
        await this.store.update(escalated, claimed.campaign.version);
        await this.appendReviewEvent(claimed.campaign, "repair_execution_failed", batch, { reason: "repair_child_failed" });
        return escalated;
      } catch {
        throw new Error("Repair result was fenced by campaign recovery");
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
  ): CampaignEvent {
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
      throw new Error("Campaign does not exist");
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
  if (!isPullRequest(batch.pullRequest, snapshot.campaign.repository)) throw new Error("Invalid Qodo pull-request identity");
  const commitReferences = snapshot.externalReferences.filter(({ kind }) => kind === "commit");
  const currentCommit = commitReferences[0];
  if (commitReferences.length !== 1 || currentCommit === undefined || currentCommit.value !== batch.commitSha) {
    throw new Error("Stale Qodo review commit does not match campaign memory");
  }
  const pullRequests = snapshot.externalReferences
    .filter(({ kind }) => kind === "pull_request")
    .map(({ value }) => value);
  if (new Set(pullRequests).size > 1) {
    throw new Error("Qodo review has ambiguous pull-request campaign memory");
  }
  if (pullRequests.length !== 1 || pullRequests[0] !== batch.pullRequest) {
    throw new Error("Stale Qodo review does not match pull-request campaign memory");
  }
  if (snapshot.events.some((event) =>
    event.eventType === "qodo_review_claimed" &&
    isRecord(event.payload) &&
    event.payload.reviewId === batch.reviewId &&
    event.payload.commitSha === batch.commitSha &&
    event.payload.reviewIteration === snapshot.campaign.qodoIteration
  )) {
    throw new Error("Stale Qodo review batch was already synchronized");
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

function parseReviewBatch(input: unknown): QodoReviewBatch {
  if (!isRecord(input)) {
    throw new Error("Invalid Qodo review batch");
  }
  const allowedKeys = new Set([
    "campaignId",
    "pullRequest",
    "reviewId",
    "commitSha",
    "testsPassed",
    "complete",
    "findings",
  ]);
  if (
    Object.keys(input).some((key) => !allowedKeys.has(key)) ||
    typeof input.campaignId !== "string" ||
    input.campaignId.trim().length === 0 ||
    typeof input.pullRequest !== "string" ||
    typeof input.reviewId !== "string" ||
    input.reviewId.trim().length === 0 ||
    typeof input.commitSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(input.commitSha) ||
    typeof input.testsPassed !== "boolean" ||
    typeof input.complete !== "boolean" ||
    !Array.isArray(input.findings) ||
    (!input.complete && input.findings.length === 0)
  ) {
    throw new Error("Invalid Qodo review batch");
  }
  const findings = input.findings.map(parseFinding);
  if (new Set(findings.map(({ id }) => id)).size !== findings.length) throw new Error("Invalid Qodo review batch");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u.test(input.pullRequest)) throw new Error("Invalid Qodo review batch");
  return {
    campaignId: input.campaignId,
    pullRequest: input.pullRequest,
    reviewId: input.reviewId,
    commitSha: input.commitSha,
    testsPassed: input.testsPassed,
    complete: input.complete,
    findings,
  };
}

function parseFinding(finding: unknown): QodoFinding {
  if (!isRecord(finding)) {
    throw new Error("Invalid Qodo finding");
  }
  const allowedKeys = new Set(["id", "severity", "status", "summary", "sourceUrl", "disposition"]);
  const severities: readonly QodoFinding["severity"][] = ["high", "medium", "low", "suggestion"];
  const statuses: readonly QodoFinding["status"][] = ["open", "fixed", "dismissed"];
  if (
    Object.keys(finding).some((key) => !allowedKeys.has(key)) ||
    typeof finding.id !== "string" ||
    finding.id.trim().length === 0 ||
    !severities.includes(finding.severity as QodoFinding["severity"]) ||
    !statuses.includes(finding.status as QodoFinding["status"]) ||
    typeof finding.summary !== "string" ||
    finding.summary.trim().length === 0 ||
    (finding.sourceUrl !== undefined &&
      (typeof finding.sourceUrl !== "string" || finding.sourceUrl.trim().length === 0)) ||
    (finding.disposition !== undefined &&
      (typeof finding.disposition !== "string" || finding.disposition.trim().length === 0))
  ) {
    throw new Error("Invalid Qodo finding");
  }
  return {
    id: finding.id,
    severity: finding.severity as QodoFinding["severity"],
    status: finding.status as QodoFinding["status"],
    summary: finding.summary,
    ...(finding.sourceUrl === undefined ? {} : { sourceUrl: finding.sourceUrl }),
    ...(finding.disposition === undefined ? {} : { disposition: finding.disposition }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repairCommit(output: unknown): string | undefined {
  if (!isRecord(output) || output.commitSha === undefined) return undefined;
  if (typeof output.commitSha !== "string" || !/^[0-9a-f]{40}$/u.test(output.commitSha)) throw new Error("Invalid repair commit");
  return output.commitSha;
}
