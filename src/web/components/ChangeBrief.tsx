import { useState } from "react";

import type { ApprovalActionSummary, ApprovalConfirmation, ApprovalProposal } from "../api.js";

interface ChangeBriefProps { readonly proposal: ApprovalProposal; readonly onApprove: (confirmation: ApprovalConfirmation) => void; readonly submitting?: boolean; readonly approved?: boolean; }

export function ChangeBrief({ proposal, onApprove, submitting = false, approved = false }: ChangeBriefProps) {
  const [reviewedDigest, setReviewedDigest] = useState<string>();
  const reviewed = reviewedDigest === proposal.actionDigest;
  const { action, brief } = proposal;
  return <section aria-labelledby="change-brief-heading" className="campaign-panel change-brief">
    <div className="panel-heading"><div><p className="eyebrow">Human approval boundary</p><h2 id="change-brief-heading">Exact external action</h2></div><span className="status-pill">{actionName(action.action)}</span></div>
    <p className="approval-boundary">This control issues scoped approval for the exact payload shown below. It does not push a branch or create a GitHub pull request.</p>
    <dl className="brief-grid">
      <Fact label="Issue" value={`${action.repository} #${String(action.issueNumber)}`} />
      <Fact label="Repository policy" value={brief.policy} />
      <Fact label="Approach" value={brief.approach} />
      <Fact label="Files" value={brief.files} />
      <Fact label="Risks" value={brief.risks} />
      <Fact label="Tests" value={brief.tests} />
      <Fact label="Safety result" value={brief.safetyResult} />
      <Fact label="Qodo status" value={brief.qodoStatus} />
      {"branch" in action ? <Fact label="Branch" value={action.branch} /> : null}
      {"commitSha" in action ? <Fact label="Commit" value={action.commitSha} mono /> : null}
      {action.action === "push_branch" ? <Fact label="Target commit" value={action.targetCommitSha} mono /> : null}
      {action.action === "create_pr" ? <><Fact label="Base branch" value={action.baseBranch} /><Fact label="Pull request title" value={action.title} /><Fact label="Pull request body" value={action.body} /></> : null}
      {action.action === "update_pr" ? <><Fact label="Pull request" value={action.pullRequest} /><Fact label="Updated body" value={action.body} /></> : null}
      {action.action === "post_issue_comment" ? <Fact label="Issue comment" value={action.body} /> : null}
      {action.action === "request_assignment" ? <Fact label="Requested assignee" value={action.assignee} /> : null}
      <Fact label="AI disclosure" value={brief.aiDisclosure} />
      <Fact label="Action digest" value={proposal.actionDigest} mono />
    </dl>
    <label className="approval-confirmation"><input checked={reviewed} disabled={submitting || approved} onChange={(event) => { setReviewedDigest(event.target.checked ? proposal.actionDigest : undefined); }} type="checkbox" />I reviewed every field in this exact payload.</label>
    <button className="primary-action approval-action" disabled={!reviewed || submitting || approved} onClick={() => { onApprove({ proposalId: proposal.proposalId, actionDigest: proposal.actionDigest, expectedCampaignVersion: proposal.expectedCampaignVersion }); }} type="button">{approved ? "Scoped proposal approved" : submitting ? "Issuing scoped approval…" : approvalButton(action.action)}</button>
  </section>;
}

function Fact({ label, value, mono = false }: { readonly label: string; readonly value: string | readonly string[]; readonly mono?: boolean }) {
  if (typeof value === "string") return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}><span className="pre-wrap">{value}</span></dd></div>;
  return <div><dt>{label}</dt><dd className={mono ? "mono" : undefined}><ul>{value.map((item) => <li key={item}>{item}</li>)}</ul></dd></div>;
}
function actionName(action: ApprovalActionSummary["action"]): string { return ({ post_issue_comment: "Issue comment", request_assignment: "Assignment request", push_branch: "Branch push", create_pr: "Pull request", update_pr: "Pull request update" })[action]; }
function approvalButton(action: ApprovalActionSummary["action"]): string { return action === "create_pr" ? "Approve scoped pull request proposal" : `Approve scoped ${actionName(action).toLowerCase()} proposal`; }
