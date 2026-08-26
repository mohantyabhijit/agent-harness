import { useCallback, useEffect, useRef, useState } from "react";

import type { ApprovalConfirmation, CampaignSnapshot, OpenQuestApi } from "../api.js";
import { CampaignTimeline } from "../components/CampaignTimeline.js";
import { ChangeBrief } from "../components/ChangeBrief.js";
import { EvidencePanel } from "../components/EvidencePanel.js";
import { OpenQuestAgentThread } from "../components/OpenQuestAgentThread.js";
import { QualityGate } from "../components/QualityGate.js";

interface CampaignPageProps {
  readonly api: Pick<OpenQuestApi, "getCampaign" | "issueApproval">;
  readonly campaignId: string;
  readonly createIdempotencyKey?: () => string;
  readonly trueForgeBaseUrl?: string;
}

export function CampaignPage({ api, campaignId, createIdempotencyKey = defaultIdempotencyKey, trueForgeBaseUrl }: CampaignPageProps) {
  const [campaign, setCampaign] = useState<CampaignSnapshot>();
  const [error, setError] = useState<{ readonly campaignId: string; readonly message: string }>();
  const [approvalError, setApprovalError] = useState<{ readonly campaignId: string; readonly message: string }>();
  const [submittingCampaignId, setSubmittingCampaignId] = useState<string>();
  const [approvedProposal, setApprovedProposal] = useState<{ readonly campaignId: string; readonly proposalId: string; readonly digest: string; readonly expectedVersion: number }>();
  const campaignController = useRef<AbortController | undefined>(undefined);
  const approvalController = useRef<AbortController | undefined>(undefined);
  const approvalLocked = useRef(false);
  const routeEpoch = useRef(0);
  const readSequence = useRef(0);
  const pendingRefresh = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const loadCampaign = useCallback(() => {
    campaignController.current?.abort();
    const controller = new AbortController();
    campaignController.current = controller;
    const epoch = routeEpoch.current;
    const sequence = ++readSequence.current;
    void api.getCampaign(campaignId, controller.signal).then((loaded) => {
      if (!controller.signal.aborted && routeEpoch.current === epoch && readSequence.current === sequence) {
        setApprovalError((current) => current?.campaignId === campaignId ? undefined : current);
        setCampaign(loaded);
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && routeEpoch.current === epoch && readSequence.current === sequence) setError({ campaignId, message: "Campaign facts could not be loaded. Please try again." });
    });
  }, [api, campaignId]);

  useEffect(() => {
    routeEpoch.current += 1;
    readSequence.current += 1;
    approvalController.current?.abort();
    approvalController.current = undefined;
    approvalLocked.current = false;
    loadCampaign();
    return () => {
      routeEpoch.current += 1;
      readSequence.current += 1;
      campaignController.current?.abort();
      campaignController.current = undefined;
      approvalController.current?.abort();
      approvalController.current = undefined;
      approvalLocked.current = false;
    };
  }, [loadCampaign]);

  useEffect(() => { if (campaign?.id === campaignId) heading.current?.focus(); }, [campaign?.id, campaignId]);

  useEffect(() => {
    if (campaign?.id !== campaignId) return;
    const expiry = campaign.approvals
      .filter(({ isActive, expiresAt }) => isActive && expiresAt !== undefined)
      .map(({ expiresAt }) => Date.parse(expiresAt ?? ""))
      .filter((instant) => Number.isFinite(instant) && instant > Date.now())
      .toSorted((left, right) => left - right)[0];
    if (expiry === undefined) return;
    const refresh = () => { if (approvalLocked.current) pendingRefresh.current = true; else loadCampaign(); };
    const timer = globalThis.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, expiry - Date.now() + 1)));
    return () => { globalThis.clearTimeout(timer); };
  }, [campaign, campaignId, loadCampaign]);

  const approve = (confirmation: ApprovalConfirmation) => {
    if (campaign === undefined || approvalLocked.current) return;
    approvalLocked.current = true;
    setSubmittingCampaignId(campaign.id);
    setApprovalError(undefined);
    const controller = new AbortController();
    const epoch = routeEpoch.current;
    approvalController.current = controller;
    let key: string;
    try { key = createIdempotencyKey(); } catch { setApprovalError({ campaignId: campaign.id, message: "A unique approval confirmation could not be created. Please try again." }); setSubmittingCampaignId(undefined); approvalLocked.current = false; return; }
    void api.issueApproval(campaign.id, confirmation, key, controller.signal).then((approval) => {
      if (!controller.signal.aborted && routeEpoch.current === epoch) {
        setApprovedProposal(approval.isActive ? { campaignId: campaign.id, proposalId: confirmation.proposalId, digest: approval.actionDigest, expectedVersion: confirmation.expectedCampaignVersion } : undefined);
        setSubmittingCampaignId(undefined);
        loadCampaign();
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && routeEpoch.current === epoch) setApprovalError({ campaignId: campaign.id, message: "Scoped approval could not be issued. Campaign state may have changed; reload before retrying." });
    }).finally(() => {
      if (approvalController.current === controller) approvalController.current = undefined;
      if (routeEpoch.current === epoch) setSubmittingCampaignId(undefined);
      approvalLocked.current = false;
      if (pendingRefresh.current && routeEpoch.current === epoch) { pendingRefresh.current = false; loadCampaign(); }
    });
  };

  if (campaign === undefined || campaign.id !== campaignId) return <main className="state-card"><h1 tabIndex={-1}>Campaign created</h1>{error?.campaignId !== campaignId ? <p role="status">Loading durable campaign facts…</p> : <><p role="alert">{error.message}</p><button onClick={() => { setError(undefined); loadCampaign(); }} type="button">Try again</button></>}</main>;
  const proposal = campaign.approvalProposal;
  const alreadyApproved = proposal !== null && (
    approvedProposal?.campaignId === campaignId && approvedProposal.proposalId === proposal.proposalId && approvedProposal.digest === proposal.actionDigest && approvedProposal.expectedVersion === proposal.expectedCampaignVersion ||
    campaign.approvals.some((approval) => approval.isActive && approval.proposalId === proposal.proposalId && approval.actionDigest === proposal.actionDigest && approval.expectedCampaignVersion === proposal.expectedCampaignVersion)
  );
  return <main className="campaign-shell">
    <header className="campaign-hero"><p className="wordmark">OPENQUEST / CAMPAIGN</p><p className="eyebrow">{campaign.lane.replace("_", " ")} · {campaign.status.replaceAll("_", " ")}</p><h1 ref={heading} tabIndex={-1}>{campaign.repository} <span>#{campaign.issueNumber}</span></h1><p>One issue, one resumable agent session, and a durable record of every verified contribution decision.</p><a href={campaign.issueUrl} rel="noreferrer" target="_blank">View source issue</a></header>
    <div className="campaign-layout"><div className="campaign-main"><CampaignTimeline approvals={campaign.approvals} events={campaign.events} /><EvidencePanel evidence={campaign.evidence} references={campaign.externalReferences} /><QualityGate escalationReason={campaign.qualityEscalationReason} findings={campaign.qodoFindings} iteration={campaign.qodoIteration} status={campaign.status} /></div><aside className="campaign-side" aria-label="Agent and approval controls"><OpenQuestAgentThread sessionId={campaign.parentSessionId} {...(trueForgeBaseUrl === undefined ? {} : { trueForgeBaseUrl })} />{proposal === null ? <section className="campaign-panel pending-proposal" aria-labelledby="proposal-pending-heading"><p className="eyebrow">Human approval boundary</p><h2 id="proposal-pending-heading">Exact proposal is pending</h2><p>The server has not published a current, validated action payload. Approval remains unavailable until a durable proposal matches this campaign and commit.</p><button disabled type="button">Approval unavailable</button></section> : <ChangeBrief approved={alreadyApproved} onApprove={approve} proposal={proposal} submitting={submittingCampaignId === campaignId} />}{approvalError?.campaignId !== campaignId ? null : <p className="campaign-error" role="alert">{approvalError.message}</p>}</aside></div>
  </main>;
}

function defaultIdempotencyKey(): string { return `approval-${globalThis.crypto.randomUUID()}`; }
function isAbort(reason: unknown): boolean { return reason instanceof DOMException && reason.name === "AbortError"; }
