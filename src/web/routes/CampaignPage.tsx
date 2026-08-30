import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ApprovalConfirmation, CampaignSnapshot, OpenQuestApi } from "../api.js";
import { CampaignTimeline } from "../components/CampaignTimeline.js";
import { CampaignActions, type CampaignAction } from "../components/CampaignActions.js";
import { ChangeBrief } from "../components/ChangeBrief.js";
import { EvidencePanel } from "../components/EvidencePanel.js";
import { IssueBriefPanel } from "../components/IssueBriefPanel.js";
import { OpenQuestAgentThread } from "../components/OpenQuestAgentThread.js";
import { QualityGate } from "../components/QualityGate.js";

interface CampaignPageProps {
  readonly api: Pick<OpenQuestApi, "getCampaign" | "issueApproval"> & Partial<Pick<OpenQuestApi, "finalizeCampaign" | "runCampaignAction">>;
  readonly campaignId: string;
  readonly createIdempotencyKey?: () => string;
  readonly createFinalizationKey?: () => string;
  readonly trueForgeBaseUrl?: string;
}

type RefreshReason = Readonly<{ kind: "initial" }> | Readonly<{ kind: "post" }> | Readonly<{ kind: "action" }> | Readonly<{ kind: "expiry"; key: string }>;
type RefreshState = Readonly<{ routeIdentity: object; status: "pending" | "failure"; reason: Exclude<RefreshReason, { kind: "initial" }> }>;
type ApprovedProposal = Readonly<{ routeIdentity: object; proposalId: string; digest: string; expectedVersion: number; expiresAt: string | undefined }>;
type RunningAction = Readonly<{ routeIdentity: object; action: CampaignAction }>;

const REFRESH_DEADLINE_MS = 10_000;

export function CampaignPage({ api, campaignId, createIdempotencyKey = defaultIdempotencyKey, createFinalizationKey = defaultFinalizationKey, trueForgeBaseUrl }: CampaignPageProps) {
  const routeIdentity = useMemo(() => ({ campaignId }), [campaignId]);
  const [campaign, setCampaign] = useState<CampaignSnapshot>();
  const [error, setError] = useState<{ readonly campaignId: string; readonly message: string }>();
  const [approvalError, setApprovalError] = useState<{ readonly routeIdentity: object; readonly message: string }>();
  const [refreshState, setRefreshState] = useState<RefreshState>();
  const [submittingRoute, setSubmittingRoute] = useState<object>();
  const [approvedProposal, setApprovedProposal] = useState<ApprovedProposal>();
  const [runningAction, setRunningAction] = useState<RunningAction>();
  const [actionError, setActionError] = useState<{ readonly routeIdentity: object; readonly message: string }>();
  const [finalization, setFinalization] = useState<{ readonly routeIdentity: object; readonly status: "submitting" | "error" }>();
  const campaignController = useRef<AbortController | undefined>(undefined);
  const campaignDeadline = useRef<{ readonly controller: AbortController; readonly timer: ReturnType<typeof globalThis.setTimeout> } | undefined>(undefined);
  const approvalController = useRef<AbortController | undefined>(undefined);
  const finalizationController = useRef<AbortController | undefined>(undefined);
  const approvalLocked = useRef(false);
  const routeEpoch = useRef(0);
  const readSequence = useRef(0);
  const pendingRefresh = useRef<Extract<RefreshReason, { kind: "expiry" }> | undefined>(undefined);
  const refreshedExpiries = useRef(new Set<string>());
  const heading = useRef<HTMLHeadingElement>(null);

  const clearCampaignDeadline = useCallback((controller?: AbortController) => {
    const deadline = campaignDeadline.current;
    if (deadline === undefined || (controller !== undefined && deadline.controller !== controller)) return;
    globalThis.clearTimeout(deadline.timer);
    campaignDeadline.current = undefined;
  }, []);

  const cancelCampaignRead = useCallback(() => {
    clearCampaignDeadline();
    campaignController.current?.abort();
    campaignController.current = undefined;
  }, [clearCampaignDeadline]);

  const loadCampaign = useCallback((reason: RefreshReason = { kind: "initial" }, authorityExpiresAt?: string) => {
    cancelCampaignRead();
    const controller = new AbortController();
    campaignController.current = controller;
    const epoch = routeEpoch.current;
    const sequence = ++readSequence.current;
    const finish = () => {
      clearCampaignDeadline(controller);
      if (campaignController.current === controller) campaignController.current = undefined;
    };
    if (reason.kind !== "initial") {
      const expiry = authorityExpiresAt === undefined ? Number.NaN : Date.parse(authorityExpiresAt);
      const untilExpiry = Number.isFinite(expiry) ? Math.max(0, expiry - Date.now()) : REFRESH_DEADLINE_MS;
      const timer = globalThis.setTimeout(() => {
        if (campaignController.current !== controller || routeEpoch.current !== epoch || readSequence.current !== sequence) return;
        clearCampaignDeadline(controller);
        campaignController.current = undefined;
        controller.abort();
        setApprovedProposal(undefined);
        setRefreshState({ routeIdentity, status: "failure", reason });
      }, Math.min(REFRESH_DEADLINE_MS, untilExpiry));
      campaignDeadline.current = { controller, timer };
    }
    void api.getCampaign(campaignId, controller.signal).then((loaded) => {
      finish();
      if (!controller.signal.aborted && routeEpoch.current === epoch && readSequence.current === sequence) {
        if (reason.kind === "expiry") refreshedExpiries.current.add(reason.key);
        setApprovalError((current) => current?.routeIdentity === routeIdentity ? undefined : current);
        setRefreshState((current) => current?.routeIdentity === routeIdentity ? undefined : current);
        setApprovedProposal(undefined);
        setError(undefined);
        setCampaign(loaded);
        if (reason.kind === "action") setRunningAction((current) => current?.routeIdentity === routeIdentity ? undefined : current);
      }
    }).catch((error: unknown) => {
      finish();
      if (!controller.signal.aborted && !isAbort(error) && routeEpoch.current === epoch && readSequence.current === sequence) {
        setApprovedProposal(undefined);
        if (reason.kind === "initial") setError({ campaignId, message: "Campaign facts could not be loaded. Please try again." });
        else setRefreshState({ routeIdentity, status: "failure", reason });
      }
    });
  }, [api, campaignId, cancelCampaignRead, clearCampaignDeadline, routeIdentity]);

  const refreshCampaign = useCallback((reason: RefreshState["reason"], authorityExpiresAt?: string) => {
    setRefreshState({ routeIdentity, status: "pending", reason });
    loadCampaign(reason, authorityExpiresAt);
  }, [loadCampaign, routeIdentity]);

  useEffect(() => {
    routeEpoch.current += 1;
    readSequence.current += 1;
    approvalController.current?.abort();
    finalizationController.current?.abort();
    approvalController.current = undefined;
    approvalLocked.current = false;
    pendingRefresh.current = undefined;
    refreshedExpiries.current.clear();
    loadCampaign();
    return () => {
      routeEpoch.current += 1;
      readSequence.current += 1;
      cancelCampaignRead();
      approvalController.current?.abort();
      approvalController.current = undefined;
      finalizationController.current?.abort();
      finalizationController.current = undefined;
      approvalLocked.current = false;
    };
  }, [cancelCampaignRead, loadCampaign]);

  useEffect(() => { if (campaign?.id === campaignId) heading.current?.focus(); }, [campaign?.id, campaignId]);

  useEffect(() => {
    if (campaign?.id !== campaignId) return;
    const expiry = campaign.approvals
      .filter(({ isActive, expiresAt }) => isActive && expiresAt !== undefined)
      .map(({ id, expiresAt }) => ({ key: `${id}:${expiresAt ?? ""}`, instant: Date.parse(expiresAt ?? "") }))
      .filter(({ key, instant }) => Number.isFinite(instant) && !refreshedExpiries.current.has(key))
      .toSorted((left, right) => left.instant - right.instant)[0];
    if (expiry === undefined) return;
    const refresh = () => { const reason = { kind: "expiry", key: expiry.key } as const; if (approvalLocked.current) pendingRefresh.current = reason; else refreshCampaign(reason); };
    const timer = globalThis.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, expiry.instant - Date.now() + 1)));
    return () => { globalThis.clearTimeout(timer); };
  }, [campaign, campaignId, refreshCampaign]);

  const approve = (confirmation: ApprovalConfirmation) => {
    if (campaign === undefined || approvalLocked.current || runningAction?.routeIdentity === routeIdentity) return;
    approvalLocked.current = true;
    setSubmittingRoute(routeIdentity);
    setApprovalError(undefined);
    const controller = new AbortController();
    const epoch = routeEpoch.current;
    approvalController.current = controller;
    let key: string;
    try { key = createIdempotencyKey(); } catch { setApprovalError({ routeIdentity, message: "A unique approval confirmation could not be created. Please try again." }); setSubmittingRoute(undefined); approvalLocked.current = false; return; }
    void api.issueApproval(campaign.id, confirmation, key, controller.signal).then((approval) => {
      if (!controller.signal.aborted && routeEpoch.current === epoch) {
        setApprovedProposal(isCurrentlyActive(approval) ? { routeIdentity, proposalId: confirmation.proposalId, digest: approval.actionDigest, expectedVersion: confirmation.expectedCampaignVersion, expiresAt: approval.expiresAt } : undefined);
        setSubmittingRoute(undefined);
        const pending = pendingRefresh.current;
        pendingRefresh.current = undefined;
        refreshCampaign(pending ?? { kind: "post" }, approval.expiresAt);
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && routeEpoch.current === epoch) setApprovalError({ routeIdentity, message: "Scoped approval could not be issued. Campaign state may have changed; reload before retrying." });
    }).finally(() => {
      if (approvalController.current === controller && routeEpoch.current === epoch) {
        approvalController.current = undefined;
        setSubmittingRoute(undefined);
        approvalLocked.current = false;
        const pending = pendingRefresh.current;
        if (pending !== undefined) { pendingRefresh.current = undefined; refreshCampaign(pending); }
      }
    });
  };

  const runAction = (action: CampaignAction) => {
    if (campaign === undefined || runningAction?.routeIdentity === routeIdentity || approvalLocked.current) return;
    if (api.runCampaignAction === undefined) {
      setActionError({ routeIdentity, message: "Campaign actions are unavailable in this view. Reconnect to the OpenQuest operator API before starting work." });
      return;
    }
    const controller = new AbortController();
    const epoch = routeEpoch.current;
    setRunningAction({ routeIdentity, action });
    setActionError(undefined);
    void api.runCampaignAction(campaign.id, action, controller.signal).then(() => {
      if (routeEpoch.current === epoch) refreshCampaign({ kind: "action" });
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && routeEpoch.current === epoch) {
        setActionError({ routeIdentity, message: "The campaign action could not be started. No external write was attempted; refresh and review the campaign state before retrying." });
        setRunningAction((current) => current?.routeIdentity === routeIdentity ? undefined : current);
      }
    });
  };

  const finalizeBrief = () => {
    if (campaign === undefined || campaign.status !== "policy_review" || campaign.issueBrief === null || finalization?.routeIdentity === routeIdentity) return;
    if (api.finalizeCampaign === undefined) { setFinalization({ routeIdentity, status: "error" }); return; }
    let key: string;
    try { key = createFinalizationKey(); } catch { setFinalization({ routeIdentity, status: "error" }); return; }
    const controller = new AbortController();
    finalizationController.current = controller;
    const epoch = routeEpoch.current;
    setFinalization({ routeIdentity, status: "submitting" });
    void api.finalizeCampaign(campaign.id, campaign.version, key, controller.signal).then(() => {
      if (!controller.signal.aborted && routeEpoch.current === epoch) {
        setFinalization(undefined);
        refreshCampaign({ kind: "action" });
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && routeEpoch.current === epoch) setFinalization({ routeIdentity, status: "error" });
    }).finally(() => { if (finalizationController.current === controller) finalizationController.current = undefined; });
  };

  if (campaign === undefined || campaign.id !== campaignId) return <main className="state-card"><h1 tabIndex={-1}>Campaign created</h1>{error?.campaignId !== campaignId ? <p role="status">Loading durable campaign facts…</p> : <><p role="alert">{error.message}</p><button onClick={() => { setError(undefined); loadCampaign(); }} type="button">Try again</button></>}</main>;
  const proposal = campaign.approvalProposal;
  const currentRefresh = refreshState?.routeIdentity === routeIdentity ? refreshState : undefined;
  const currentRunningAction = runningAction?.routeIdentity === routeIdentity ? runningAction.action : undefined;
  const currentFinalization = finalization?.routeIdentity === routeIdentity ? finalization.status : undefined;
  const alreadyApproved = proposal !== null && (
    isOptimisticallyActive(approvedProposal) && approvedProposal.routeIdentity === routeIdentity && approvedProposal.proposalId === proposal.proposalId && approvedProposal.digest === proposal.actionDigest && approvedProposal.expectedVersion === proposal.expectedCampaignVersion ||
    campaign.approvals.some((approval) => isCurrentlyActive(approval) && approval.proposalId === proposal.proposalId && approval.actionDigest === proposal.actionDigest && approval.expectedCampaignVersion === proposal.expectedCampaignVersion)
  );
  return <main className="campaign-shell">
    <header className="campaign-hero"><p className="wordmark">OPENQUEST / CAMPAIGN</p><p className="eyebrow">{campaign.lane.replace("_", " ")} · {campaign.status.replaceAll("_", " ")}</p><h1 ref={heading} tabIndex={-1}>{campaign.repository} <span>#{campaign.issueNumber}</span></h1><p>One issue, one resumable agent session, and a durable record of every verified contribution decision.</p><a href={campaign.issueUrl} rel="noreferrer" target="_blank">View source issue</a></header>
    <div className="campaign-layout"><div className="campaign-main">{campaign.issueBrief === null ? <section className="campaign-panel" role="alert"><h2>Issue analysis unavailable</h2><p>OpenQuest did not return a valid source-backed brief. Finalization and sandbox work remain locked.</p></section> : <IssueBriefPanel brief={campaign.issueBrief} finalized={campaign.status !== "policy_review"} onFinalize={finalizeBrief} submitting={currentFinalization === "submitting"} />}{currentFinalization === "error" ? <p className="campaign-error" role="alert">The issue brief could not be finalized. Reload the latest campaign facts and try again.</p> : null}<CampaignActions action={campaign.nextAllowedAction} onRun={runAction} {...(currentRunningAction === undefined ? {} : { running: currentRunningAction })} status={campaign.status} />{actionError?.routeIdentity !== routeIdentity ? null : <p className="campaign-error" role="alert">{actionError.message}</p>}<CampaignTimeline approvals={campaign.approvals} events={campaign.events} /><EvidencePanel evidence={campaign.evidence} references={campaign.externalReferences} /><QualityGate escalationReason={campaign.qualityEscalationReason} findings={campaign.qodoFindings} iteration={campaign.qodoIteration} status={campaign.status} /></div><aside className="campaign-side" aria-label="Agent and approval controls"><OpenQuestAgentThread sessionId={campaign.parentSessionId} {...(trueForgeBaseUrl === undefined ? {} : { trueForgeBaseUrl })} />{currentRefresh?.status === "pending" ? <p aria-label="Refreshing campaign facts" className="campaign-error" role="status">Refreshing authoritative campaign facts…</p> : currentRefresh?.status === "failure" ? <div aria-label="Campaign facts refresh failed" className="campaign-error" role="alert"><p>Campaign facts could not be refreshed. The loaded campaign remains visible, but campaign actions remain locked until the refresh succeeds.</p><button onClick={() => { refreshCampaign(currentRefresh.reason); }} type="button">Retry campaign refresh</button></div> : null}{proposal === null ? <section className="campaign-panel pending-proposal" aria-labelledby="proposal-pending-heading"><p className="eyebrow">Human approval boundary</p><h2 id="proposal-pending-heading">Exact proposal is pending</h2><p>The server has not published a current, validated action payload. Approval remains unavailable until a durable proposal matches this campaign and commit.</p><button disabled type="button">Approval unavailable</button></section> : <ChangeBrief approved={alreadyApproved} onApprove={approve} proposal={proposal} submitting={submittingRoute === routeIdentity || currentRunningAction !== undefined} />}{approvalError?.routeIdentity !== routeIdentity ? null : <p className="campaign-error" role="alert">{approvalError.message}</p>}</aside></div>
  </main>;
}

function defaultIdempotencyKey(): string { return `approval-${globalThis.crypto.randomUUID()}`; }
function defaultFinalizationKey(): string { return `finalize-${globalThis.crypto.randomUUID()}`; }
function isAbort(reason: unknown): boolean { return reason instanceof DOMException && reason.name === "AbortError"; }
function isCurrentlyActive(approval: CampaignSnapshot["approvals"][number]): boolean { return approval.isActive && (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > Date.now()); }
function isOptimisticallyActive(approval: ApprovedProposal | undefined): approval is ApprovedProposal { return approval !== undefined && (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > Date.now()); }
