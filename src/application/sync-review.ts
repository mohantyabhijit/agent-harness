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
import type { RepairVerifierPort, VerifiedRepair } from "./ports/repair-verifier.js";
import type { PersistenceLease } from "./ports/persistence-lease.js";
import { PersistenceLeaseRevoked } from "./ports/persistence-lease.js";
import { z } from "zod";

export type { QodoReviewBatch } from "./qodo-review-batch.js";

interface ClaimedReview {
  readonly campaign: Campaign;
  readonly gate: QualityGateResult;
}

export interface ReviewExecutionContext extends HarnessRequestOptions {
  readonly persistenceLease?: PersistenceLease;
}

const REPAIR_TEST_POLICY = "openquest-repair-tests-v1";

export class SyncReview {
  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly repairVerifier?: RepairVerifierPort,
  ) {}

  async enforceIterationLimit(campaignId: string, context?: ReviewExecutionContext): Promise<Campaign> {
    assertLease(context);
    const snapshot = await this.requiredSnapshot(campaignId);
    assertLease(context);
    if (snapshot.campaign.status !== "qodo_review") throw new ApplicationError("invalid_transition");
    if (snapshot.campaign.qodoIteration !== 3) throw new ApplicationError("invalid_transition");
    const pullRequest = singletonExternalReference(snapshot, "pull_request");
    const commitSha = singletonExternalReference(snapshot, "commit");
    const escalated = transitionCampaign(snapshot.campaign, "human_escalation");
    await this.store.escalateQodoReview(campaignId, { expectedVersion: snapshot.campaign.version, expectedStatus: "qodo_review", campaign: escalated, ...(context?.persistenceLease === undefined ? {} : { persistenceLease: context.persistenceLease }), event: {
      id: this.nextId(),
      eventType: "quality_gate_escalated",
      occurredAt: this.clock.now(),
      payload: {
        pullRequest,
        commitSha,
        iteration: 3,
        reason: "maximum_qodo_iterations",
        claimedCampaignVersion: escalated.version,
      },
    } });
    return escalated;
  }

  async execute(campaignId: string, input: QodoReviewBatch, context?: ReviewExecutionContext): Promise<Campaign> {
    const batch = parseQodoReviewBatch(input);
    if (batch.campaignId !== campaignId) {
      throw new ApplicationError("campaign_conflict");
    }
    assertLease(context);
    const snapshot = await this.requiredSnapshot(campaignId);
    assertLease(context);
    if (snapshot.campaign.status !== "qodo_review") {
      throw new ApplicationError("invalid_transition");
    }
    if (isIdenticalAuthenticatedReplay(snapshot, batch)) return snapshot.campaign;
    assertReviewIsCurrent(snapshot, batch);
    if (!batch.complete) return snapshot.campaign;

    const combinedFindings = mergeFindings(snapshot.qodoFindings, batch.findings);
    const gate = evaluateQualityGate({
      testsPassed: batch.testsPassed,
      iteration: snapshot.campaign.qodoIteration,
      findings: combinedFindings,
    });
    const claimed = claimReview(snapshot.campaign, gate);
    const claimedEvent = this.reviewEvent(claimed.campaign, "qodo_review_claimed", batch, {
      outcome: gate.outcome,
      reviewIteration: snapshot.campaign.qodoIteration,
      findings: batch.findings,
    });

    const findingIteration = Math.max(1, claimed.campaign.qodoIteration);
    const changedFindings = batch.findings.filter((finding) =>
      !snapshot.qodoFindings.some((persisted) => equalFinding(persisted, finding)),
    );
    const findingRecords = changedFindings.map((finding) => ({
      iteration: findingIteration,
      finding,
      event: this.reviewEvent(claimed.campaign, "qodo_finding_recorded", batch, {
        iteration: findingIteration,
        finding,
      }),
    }));

    let outcomeEvent: CampaignEventInput;
    if (gate.outcome === "pass") {
      outcomeEvent = this.reviewEvent(claimed.campaign, "quality_gate_passed", batch, {
        iteration: claimed.campaign.qodoIteration,
      });
    } else if (gate.outcome === "escalate") {
      outcomeEvent = this.reviewEvent(claimed.campaign, "quality_gate_escalated", batch, {
        iteration: snapshot.campaign.qodoIteration,
        reason: gate.reason,
      });
    } else {
      outcomeEvent = this.reviewEvent(claimed.campaign, "quality_gate_repair_requested", batch, {
        iteration: gate.nextIteration,
      });
    }
    await this.store.applyQodoReview(campaignId, {
      expectedVersion: snapshot.campaign.version,
      expectedCommitSha: batch.commitSha,
      expectedPullRequest: batch.pullRequest,
      reviewId: batch.reviewId,
      reviewIteration: snapshot.campaign.qodoIteration,
      campaign: claimed.campaign,
      claimedEvent,
      findings: findingRecords,
      outcomeEvent,
      ...(context?.persistenceLease === undefined ? {} : { persistenceLease: context.persistenceLease }),
    });
    if (gate.outcome !== "repair") return claimed.campaign;

    try {
      const result = await this.harness.runChildSession(
        this.repairPacket(snapshot, claimed.campaign, batch, combinedFindings),
        "repair",
        context,
      );
      assertLease(context);
      const repair = parseRepairOutput(result.output, batch.commitSha);
      if (this.repairVerifier === undefined) throw new Error("Repair verifier is unavailable");
      const verified = await this.repairVerifier.verify({
        campaignId,
        repository: snapshot.campaign.repository,
        pullRequest: batch.pullRequest,
        childSessionId: result.sessionId,
        expectedParentCommitSha: batch.commitSha,
        testPolicy: REPAIR_TEST_POLICY,
        candidate: repair,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
        ...(context?.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
      });
      assertLease(context);
      const authority = parseVerifiedRepair(verified);
      assertVerifiedRepairBinding(authority, {
        campaignId,
        repository: snapshot.campaign.repository,
        pullRequest: batch.pullRequest,
        childSessionId: result.sessionId,
        expectedParentCommitSha: batch.commitSha,
        candidateCommitSha: repair.commitSha,
        testPolicy: REPAIR_TEST_POLICY,
      });
      const nextCommitSha = authority.candidateCommitSha;
      const resultingVersion = claimed.campaign.version + 1;
      if (isCancelled(context)) throw new Error("Repair was cancelled");
      assertLease(context);
      const recordedVersion = await this.store.recordChildResult(campaignId, {
        expectedVersion: claimed.campaign.version,
        expectedStatus: "repair",
        childSessionId: result.sessionId,
        event: this.reviewEvent(claimed.campaign, "campaign_operation_completed", batch, {
          operation: "repair",
          iteration: gate.nextIteration,
          childSessionId: result.sessionId,
          sandboxSessionId: authority.sandboxSessionId,
          artifacts: result.artifacts,
          summary: result.summary,
          output: { status: "verified", commitSha: authority.candidateCommitSha, verification: authority },
          resultingCampaignVersion: resultingVersion,
        }),
        newCommitSha: nextCommitSha,
        sandboxSessionId: authority.sandboxSessionId,
        ...(context?.persistenceLease === undefined ? {} : { persistenceLease: context.persistenceLease }),
        operationResult: {
          operation: "repair",
          currentCommitSha: nextCommitSha,
          pullRequest: batch.pullRequest,
          qodoIteration: claimed.campaign.qodoIteration,
          repairVerification: authority,
        },
      });
      return { ...claimed.campaign, version: recordedVersion };
    } catch (error) {
      if (error instanceof PersistenceLeaseRevoked || leaseIsRevoked(context)) throw error;
      try {
        assertLease(context);
        const escalated = transitionCampaign(claimed.campaign, "human_escalation");
        const reason = isCancelled(context) ? "repair_cancelled" : "repair_child_failed";
        await this.store.escalateQodoReview(campaignId, {
          expectedVersion: claimed.campaign.version,
          expectedStatus: "repair",
          campaign: escalated,
          ...(context?.persistenceLease === undefined ? {} : { persistenceLease: context.persistenceLease }),
          event: this.reviewEvent(claimed.campaign, "quality_gate_escalated", batch, { reason, iteration: claimed.campaign.qodoIteration }),
        });
        return escalated;
      } catch (recoveryError) {
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
      goal: `Repair validated Qodo findings for iteration ${String(claimedCampaign.qodoIteration)}. Return only repair_result_v1 after tests pass; never publish or update the pull request.`,
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
        syncSessionId: batch.syncSessionId,
        reviewId: batch.reviewId,
        reviewUrl: batch.reviewUrl,
        sourceIdentity: batch.sourceIdentity,
        commitSha: batch.commitSha,
        testsPassed: batch.testsPassed,
        complete: batch.complete,
        iteration: claimedCampaign.qodoIteration,
        unresolvedFindings,
        externalWritesAllowed: false,
        publicationRequiresFreshUpdatePrApproval: true,
        responseContract: "repair_result_v1",
        responseSchema: {
          additionalProperties: false,
          required: ["status", "commitSha", "verification"],
          fields: {
            status: { const: "completed" },
            commitSha: { type: "40-character lowercase Git SHA", semantics: "new local repair commit, different from the reviewed commit" },
            verification: {
              additionalProperties: false,
              required: ["testsPassed", "commands", "evidence"],
              fields: {
                testsPassed: { const: true },
                commands: { type: "non-empty array of exact commands run" },
                evidence: { type: "non-empty array", item: { additionalProperties: false, required: ["kind", "sourceUrl", "observation"], kind: { const: "direct" } } },
              },
            },
          },
        },
      },
    };
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
        reviewUrl: batch.reviewUrl,
        sourceIdentity: batch.sourceIdentity,
        sourceReceipt: batch.sourceReceipt,
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
  if (batch.reviewUrl !== `${batch.pullRequest}#pullrequestreview-${batch.reviewId.replace(/^.*?(\d+)$/u, "$1")}` &&
    !batch.reviewUrl.startsWith(`${batch.pullRequest}#pullrequestreview-`)) throw new ApplicationError("campaign_conflict");
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

function isIdenticalAuthenticatedReplay(snapshot: CampaignSnapshot, batch: QodoReviewBatch): boolean {
  const prior = snapshot.events.filter(({ eventType, payload }) =>
    eventType === "qodo_review_claimed" && isRecord(payload) &&
    payload.reviewId === batch.reviewId,
  );
  if (prior.length === 0) return false;
  if (prior.length !== 1) throw new ApplicationError("campaign_conflict");
  const payload = prior[0]?.payload;
  if (!isRecord(payload)) throw new ApplicationError("campaign_conflict");
  const priorFindings = payload.findings;
  const incomingById = new Map(batch.findings.map((finding) => [finding.id, finding]));
  const identical = payload.pullRequest === batch.pullRequest && payload.reviewId === batch.reviewId &&
    payload.reviewUrl === batch.reviewUrl && payload.sourceIdentity === batch.sourceIdentity &&
    payload.sourceReceipt === batch.sourceReceipt && payload.commitSha === batch.commitSha &&
    payload.testsPassed === batch.testsPassed && payload.complete === batch.complete &&
    Array.isArray(priorFindings) && priorFindings.length === batch.findings.length &&
    priorFindings.every((finding) => isQodoFinding(finding) && incomingById.has(finding.id) && equalFinding(finding, incomingById.get(finding.id) as QodoFinding));
  if (!identical) throw new ApplicationError("campaign_conflict");
  return true;
}

function isQodoFinding(value: unknown): value is QodoFinding {
  return isRecord(value) && typeof value.id === "string" && typeof value.severity === "string" && typeof value.status === "string" &&
    typeof value.summary === "string" && typeof value.sourceUrl === "string";
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

function equalFinding(left: QodoFinding, right: QodoFinding): boolean {
  return left.id === right.id && left.severity === right.severity && left.status === right.status &&
    left.summary === right.summary && left.sourceUrl === right.sourceUrl && left.body === right.body &&
    left.path === right.path && left.line === right.line && left.disposition === right.disposition;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const repairOutputSchema = z.object({
  status: z.literal("completed"),
  commitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  verification: z.object({
    testsPassed: z.literal(true),
    commands: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
    evidence: z.array(z.object({
      kind: z.literal("direct"),
      sourceUrl: z.url().max(2_048),
      observation: z.string().trim().min(1).max(2_000),
    }).strict()).min(1).max(100),
  }).strict(),
}).strict();

function parseRepairOutput(output: unknown, previousCommitSha: string): z.infer<typeof repairOutputSchema> {
  const parsed = repairOutputSchema.parse(output);
  if (parsed.commitSha === previousCommitSha) throw new Error("Repair did not produce a new verified commit");
  return parsed;
}

function isCancelled(context?: HarnessRequestOptions): boolean {
  return context?.signal?.aborted === true;
}

function assertLease(context?: ReviewExecutionContext): void { context?.persistenceLease?.assertCurrent(); }
function leaseIsRevoked(context?: ReviewExecutionContext): boolean {
  try { assertLease(context); return false; } catch { return true; }
}

const verifiedRepairSchema = z.object({
  receipt: z.string().trim().min(16).max(512),
  campaignId: z.string().trim().min(1).max(200),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(200),
  pullRequest: z.url().max(2_048),
  childSessionId: z.string().trim().min(1).max(512),
  sandboxSessionId: z.string().trim().min(1).max(512),
  expectedParentCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  candidateCommitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  testPolicy: z.string().trim().min(1).max(200),
  testsPassed: z.literal(true),
  commands: z.array(z.string().trim().min(1).max(2_000)).min(1).max(100),
  evidence: z.array(z.object({ kind: z.literal("direct"), sourceUrl: z.url().max(2_048), observation: z.string().trim().min(1).max(2_000) }).strict()).min(1).max(100),
}).strict();

function parseVerifiedRepair(value: VerifiedRepair): z.infer<typeof verifiedRepairSchema> { return verifiedRepairSchema.parse(value); }

function assertVerifiedRepairBinding(
  receipt: z.infer<typeof verifiedRepairSchema>,
  expected: Omit<z.infer<typeof verifiedRepairSchema>, "receipt" | "sandboxSessionId" | "testsPassed" | "commands" | "evidence">,
): void {
  for (const key of ["campaignId", "repository", "pullRequest", "childSessionId", "expectedParentCommitSha", "candidateCommitSha", "testPolicy"] as const) {
    if (receipt[key] !== expected[key]) throw new Error(`Repair verification ${key} does not match the request`);
  }
  if (receipt.candidateCommitSha === receipt.expectedParentCommitSha) throw new Error("Repair verifier returned the reviewed commit");
}

function singletonExternalReference(snapshot: CampaignSnapshot, kind: "pull_request" | "commit"): string {
  const references = snapshot.externalReferences.filter((reference) => reference.kind === kind);
  if (references.length !== 1 || references[0] === undefined) throw new ApplicationError("campaign_conflict");
  return references[0].value;
}
