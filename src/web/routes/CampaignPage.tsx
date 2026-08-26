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
  const [approvalError, setApprovalError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [approvedDigest, setApprovedDigest] = useState<string>();
  const campaignController = useRef<AbortController | undefined>(undefined);
  const approvalController = useRef<AbortController | undefined>(undefined);
  const approvalLocked = useRef(false);
  const mountedGeneration = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const loadedCampaignId = useRef<string | undefined>(undefined);

  const loadCampaign = useCallback(() => {
    campaignController.current?.abort();
    const controller = new AbortController();
    campaignController.current = controller;
    const generation = ++mountedGeneration.current;
    void api.getCampaign(campaignId, controller.signal).then((loaded) => {
      if (!controller.signal.aborted && mountedGeneration.current === generation) {
        if (loadedCampaignId.current !== loaded.id) {
          setApprovalError(undefined);
          setSubmitting(false);
          setApprovedDigest(undefined);
        }
        loadedCampaignId.current = loaded.id;
        setCampaign(loaded);
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && mountedGeneration.current === generation) setError({ campaignId, message: "Campaign facts could not be loaded. Please try again." });
    });
  }, [api, campaignId]);

  useEffect(() => {
    approvalController.current?.abort();
    approvalController.current = undefined;
    approvalLocked.current = false;
    loadCampaign();
    return () => {
      mountedGeneration.current += 1;
      campaignController.current?.abort();
      campaignController.current = undefined;
      approvalController.current?.abort();
      approvalController.current = undefined;
      approvalLocked.current = false;
    };
  }, [loadCampaign]);

  useEffect(() => { if (campaign?.id === campaignId) heading.current?.focus(); }, [campaign?.id, campaignId]);

  const approve = (confirmation: ApprovalConfirmation) => {
    if (campaign === undefined || approvalLocked.current) return;
    approvalLocked.current = true;
    setSubmitting(true);
    setApprovalError(undefined);
    const controller = new AbortController();
    const generation = mountedGeneration.current;
    approvalController.current = controller;
    let key: string;
    try { key = createIdempotencyKey(); } catch { setApprovalError("A unique approval confirmation could not be created. Please try again."); setSubmitting(false); approvalLocked.current = false; return; }
    void api.issueApproval(campaign.id, confirmation, key, controller.signal).then((approval) => {
      if (!controller.signal.aborted && mountedGeneration.current === generation) {
        setApprovedDigest(approval.actionDigest);
        setSubmitting(false);
        approvalLocked.current = false;
        loadCampaign();
      }
    }).catch((reason: unknown) => {
      if (!isAbort(reason) && mountedGeneration.current === generation) setApprovalError("Scoped approval could not be issued. Campaign state may have changed; reload before retrying.");
    }).finally(() => {
      if (approvalController.current === controller) approvalController.current = undefined;
      if (mountedGeneration.current === generation) setSubmitting(false);
      approvalLocked.current = false;
    });
  };

  if (campaign === undefined || campaign.id !== campaignId) return <main className="state-card"><h1 tabIndex={-1}>Campaign created</h1>{error?.campaignId !== campaignId ? <p role="status">Loading durable campaign facts…</p> : <><p role="alert">{error.message}</p><button onClick={() => { setError(undefined); loadCampaign(); }} type="button">Try again</button></>}</main>;
  const proposal = campaign.approvalProposal;
  const alreadyApproved = proposal !== null && (approvedDigest === proposal.actionDigest || campaign.approvals.some((approval) => approval.actionDigest === proposal.actionDigest && approvalIsActiveOrConsumed(approval)));
  return <main className="campaign-shell">
    <header className="campaign-hero"><p className="wordmark">OPENQUEST / CAMPAIGN</p><p className="eyebrow">{campaign.lane.replace("_", " ")} · {campaign.status.replaceAll("_", " ")}</p><h1 ref={heading} tabIndex={-1}>{campaign.repository} <span>#{campaign.issueNumber}</span></h1><p>One issue, one resumable agent session, and a durable record of every verified contribution decision.</p><a href={campaign.issueUrl} rel="noreferrer" target="_blank">View source issue</a></header>
    <div className="campaign-layout"><div className="campaign-main"><CampaignTimeline approvals={campaign.approvals} events={campaign.events} /><EvidencePanel evidence={campaign.evidence} references={campaign.externalReferences} /><QualityGate findings={campaign.qodoFindings} iteration={campaign.qodoIteration} status={campaign.status} /></div><aside className="campaign-side" aria-label="Agent and approval controls"><OpenQuestAgentThread sessionId={campaign.parentSessionId} {...(trueForgeBaseUrl === undefined ? {} : { trueForgeBaseUrl })} />{proposal === null ? <section className="campaign-panel pending-proposal" aria-labelledby="proposal-pending-heading"><p className="eyebrow">Human approval boundary</p><h2 id="proposal-pending-heading">Exact proposal is pending</h2><p>The server has not published a current, validated action payload. Approval remains unavailable until a durable proposal matches this campaign and commit.</p><button disabled type="button">Approval unavailable</button></section> : <ChangeBrief approved={alreadyApproved} onApprove={approve} proposal={proposal} submitting={submitting} />}{approvalError === undefined ? null : <p className="campaign-error" role="alert">{approvalError}</p>}</aside></div>
  </main>;
}

function defaultIdempotencyKey(): string { return `approval-${globalThis.crypto.randomUUID()}`; }
function isAbort(reason: unknown): boolean { return reason instanceof DOMException && reason.name === "AbortError"; }
function approvalIsActiveOrConsumed(approval: CampaignSnapshot["approvals"][number]): boolean { return approval.status === "consumed" || approval.status === "approved" && (approval.expiresAt === undefined || Date.parse(approval.expiresAt) > Date.now()); }
