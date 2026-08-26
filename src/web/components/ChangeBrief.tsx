import { useState } from "react";

import type { ApprovalProposal, ExternalActionPayload } from "../api.js";

interface ChangeBriefProps { readonly proposal: ApprovalProposal; readonly onApprove: (payload: ExternalActionPayload) => void; readonly submitting?: boolean; readonly approved?: boolean; }

export function ChangeBrief({ proposal, onApprove, submitting = false, approved = false }: ChangeBriefProps) {
  const [reviewedDigest, setReviewedDigest] = useState<string>();
  const reviewed = reviewedDigest === proposal.actionDigest;
  const { payload, brief } = proposal;
  return <section aria-labelledby="change-brief-heading" className="campaign-panel change-brief">
    <div className="panel-heading"><div><p className="eyebrow">Human approval boundary</p><h2 id="change-brief-heading">Exact external action</h2></div><span className="status-pill">{actionName(payload.action)}</span></div>
    <p className="approval-boundary">This control issues scoped approval for the exact payload shown below. It does not push a branch or create a GitHub pull request.</p>
    <dl className="brief-grid">
      <Fact label="Issue" value={`${payload.repository} #${String(payload.issueNumber)}`} />
      <Fact label="Repository policy" value={brief.policy} />
      <Fact label="Approach" value={brief.approach} />
      <Fact label="Files" value={brief.files} />
      <Fact label="Risks" value={brief.risks} />
      <Fact label="Tests" value={brief.tests} />
      <Fact label="Safety result" value={brief.safetyResult} />
      <Fact label="Qodo status" value={brief.qodoStatus} />
      {"branch" in payload ? <Fact label="Branch" value={payload.branch} /> : null}
      {"commitSha" in payload ? <Fact label="Commit" value={payload.commitSha} mono /> : null}
      {payload.action === "create_pr" ? <><Fact label="Base branch" value={payload.baseBranch} /><Fact label="Pull request title" value={payload.title} /><Fact label="Pull request body" value={payload.body} /></> : null}
      {payload.action === "update_pr" ? <><Fact label="Pull request" value={payload.pullRequest} /><Fact label="Updated body" value={payload.body} /></> : null}
      {payload.action === "post_issue_comment" ? <Fact label="Issue comment" value={payload.body} /> : null}
      {payload.action === "request_assignment" ? <Fact label="Requested assignee" value={payload.assignee} /> : null}
      <Fact label="AI disclosure" value={brief.aiDisclosure} />
      <Fact label="Action digest" value={proposal.actionDigest} mono />
    </dl>
    <label className="approval-confirmation"><input checked={reviewed} disabled={submitting || approved} onChange={(event) => { setReviewedDigest(event.target.checked ? proposal.actionDigest : undefined); }} type="checkbox" />I reviewed every field in this exact payload.</label>
    <button className="primary-action approval-action" disabled={!reviewed || submitting || approved} onClick={() => { onApprove(payload); }} type="button">{approved ? "Scoped proposal approved" : submitting ? "Issuing scoped approval…" : approvalButton(payload.action)}</button>
  </section>;
}

function Fact({ label, value, mono = false }: { readonly label: string; readonly value: string | readonly string[]; readonly mono?: boolean }) {
  if (typeof value === "string") return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}><span className="pre-wrap">{value}</span></dd></div>;
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}><ul>{value.map((item) => <li key={item}>{item}</li>)}</ul></dd></div>;
}
function actionName(action: ExternalActionPayload["action"]): string { return ({ post_issue_comment: "Issue comment", request_assignment: "Assignment request", push_branch: "Branch push", create_pr: "Pull request", update_pr: "Pull request update" })[action]; }
function approvalButton(action: ExternalActionPayload["action"]): string { return action === "create_pr" ? "Approve scoped pull request proposal" : `Approve scoped ${actionName(action).toLowerCase()} proposal`; }
