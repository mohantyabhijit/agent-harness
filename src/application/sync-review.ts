import { transitionCampaign, type Campaign } from "../domain/campaign.js";
import {
  evaluateQualityGate,
  type QodoFinding,
  type QualityGateResult,
} from "../domain/quality-gate.js";
import type { Clock, IdGenerator } from "./create-campaign.js";
import type { CampaignSnapshot, CampaignStore } from "./ports/campaign-store.js";
import type { CampaignPacket, HarnessPort, HarnessSessionResult } from "./ports/harness.js";

export class SyncReview {
  constructor(
    private readonly store: CampaignStore,
    private readonly harness: HarnessPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    campaignId: string,
    input: QodoFinding | readonly QodoFinding[],
    testsPassed = true,
  ): Promise<Campaign> {
    const snapshot = await this.requiredSnapshot(campaignId);
    if (snapshot.campaign.status !== "qodo_review") {
      throw new Error("Campaign is not awaiting Qodo review");
    }
    if (typeof testsPassed !== "boolean") {
      throw new Error("Invalid test result for Qodo review");
    }
    const candidates: readonly unknown[] = isFindingList(input) ? input : [input];
    const findings = candidates.map(parseFinding);

    const findingIteration = Math.max(1, snapshot.campaign.qodoIteration);
    for (const finding of findings) {
      await this.store.recordQodoFinding(campaignId, findingIteration, finding);
      await this.appendEvent(campaignId, "qodo_finding_recorded", {
        iteration: findingIteration,
        finding,
      });
    }

    const combinedFindings = mergeFindings(snapshot.qodoFindings, findings);
    const gate = evaluateQualityGate({
      testsPassed,
      iteration: snapshot.campaign.qodoIteration,
      findings: combinedFindings,
    });
    return this.applyGate(snapshot, gate);
  }

  private async applyGate(
    snapshot: CampaignSnapshot,
    gate: QualityGateResult,
  ): Promise<Campaign> {
    const { campaign } = snapshot;
    if (gate.outcome === "pass") {
      await this.appendEvent(campaign.id, "quality_gate_passed", {
        iteration: campaign.qodoIteration,
      });
      return campaign;
    }
    if (gate.outcome === "escalate") {
      const escalated = transitionCampaign(campaign, "human_escalation");
      await this.store.update(escalated, campaign.version);
      await this.appendEvent(campaign.id, "quality_gate_escalated", {
        iteration: campaign.qodoIteration,
        reason: gate.reason,
      });
      return escalated;
    }

    const repairing = {
      ...transitionCampaign(campaign, "repair"),
      qodoIteration: gate.nextIteration,
    };
    await this.store.update(repairing, campaign.version);
    await this.appendEvent(campaign.id, "quality_gate_repair_requested", {
      iteration: gate.nextIteration,
    });
    const result = await this.harness.runChildSession(this.packet(snapshot), "repair");
    await this.recordRepairSession(campaign.id, result, gate.nextIteration);
    return repairing;
  }

  private async recordRepairSession(
    campaignId: string,
    result: HarnessSessionResult,
    iteration: number,
  ): Promise<void> {
    await this.store.setExternalReference(campaignId, {
      kind: "child_session",
      value: result.sessionId,
    });
    for (const artifact of result.artifacts) {
      await this.store.setExternalReference(campaignId, { kind: "sandbox", value: artifact });
    }
    await this.appendEvent(campaignId, "campaign_operation_completed", {
      operation: "repair",
      iteration,
      childSessionId: result.sessionId,
      artifacts: result.artifacts,
      summary: result.summary,
      output: result.output,
    });
  }

  private packet(snapshot: CampaignSnapshot): CampaignPacket {
    return {
      campaignId: snapshot.campaign.id,
      repository: snapshot.campaign.repository,
      issueNumber: snapshot.campaign.issueNumber,
      goal: "Repair only validated Qodo findings with the smallest safe change",
      verifiedEvidence: snapshot.evidence
        .filter(({ kind }) => kind === "direct")
        .map(({ sourceUrl, observation }) => ({ sourceUrl, observation })),
      approvals: snapshot.approvals.map(({ action, actionDigest, status }) => ({
        action,
        digest: actionDigest,
        status,
      })),
    };
  }

  private async appendEvent(campaignId: string, eventType: string, payload: unknown): Promise<void> {
    const id = this.ids.next();
    if (id.trim().length === 0) {
      throw new Error("Invalid campaign event identifier");
    }
    await this.store.appendEvent(campaignId, {
      id,
      eventType,
      payload,
      occurredAt: this.clock.now(),
    });
  }

  private async requiredSnapshot(campaignId: string): Promise<CampaignSnapshot> {
    const snapshot = await this.store.get(campaignId);
    if (snapshot === undefined) {
      throw new Error("Campaign does not exist");
    }
    return snapshot;
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

function isFindingList(
  input: QodoFinding | readonly QodoFinding[],
): input is readonly QodoFinding[] {
  return Array.isArray(input);
}

function parseFinding(finding: unknown): QodoFinding {
  if (typeof finding !== "object" || finding === null) {
    throw new Error("Invalid Qodo finding");
  }
  const value = finding as Record<string, unknown>;
  const severities: readonly QodoFinding["severity"][] = ["high", "medium", "low", "suggestion"];
  const statuses: readonly QodoFinding["status"][] = ["open", "fixed", "dismissed"];
  if (
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    !severities.includes(value.severity as QodoFinding["severity"]) ||
    !statuses.includes(value.status as QodoFinding["status"]) ||
    typeof value.summary !== "string" ||
    value.summary.trim().length === 0 ||
    (value.sourceUrl !== undefined &&
      (typeof value.sourceUrl !== "string" || value.sourceUrl.trim().length === 0)) ||
    (value.disposition !== undefined &&
      (typeof value.disposition !== "string" || value.disposition.trim().length === 0))
  ) {
    throw new Error("Invalid Qodo finding");
  }
  return {
    id: value.id,
    severity: value.severity as QodoFinding["severity"],
    status: value.status as QodoFinding["status"],
    summary: value.summary,
    ...(value.sourceUrl === undefined ? {} : { sourceUrl: value.sourceUrl }),
    ...(value.disposition === undefined ? {} : { disposition: value.disposition }),
  };
}
