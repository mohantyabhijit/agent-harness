import type { PublicationAction as ApprovedPublicationAction, PublicationResult } from "../api.js";

interface PublicationActionProps {
  readonly action: ApprovedPublicationAction;
  readonly approvalId?: string;
  readonly onPublish: () => void;
  readonly result?: PublicationResult;
  readonly error?: "unknown" | "generic";
  readonly submitting?: boolean;
}

export function PublicationAction({ action, approvalId, onPublish, result, error, submitting = false }: PublicationActionProps) {
  const approved = approvalId !== undefined;
  return <section aria-labelledby="publication-action-heading" className="campaign-panel publication-action">
    <div className="panel-heading"><div><p className="eyebrow">Separate execution step</p><h2 id="publication-action-heading">Execute approved action</h2></div><span className="status-pill">{action.action === "push_branch" ? "Branch push" : "Pull request"}</span></div>
    <p className="approval-boundary">Approval and execution are separate. This step can only send the exact action already projected by the server and approved for this campaign.</p>
    <dl className="brief-grid publication-details">
      <div><dt>Repository</dt><dd>{action.repository} #{String(action.issueNumber)}</dd></div>
      <div><dt>Branch</dt><dd className="mono">{action.branch}</dd></div>
      {action.action === "push_branch" ? <div><dt>Approved commit</dt><dd className="mono">{action.targetCommitSha}</dd></div> : <div><dt>Base branch</dt><dd className="mono">{action.baseBranch}</dd></div>}
    </dl>
    {!approved ? <p role="status">Execution is locked until this exact proposal has an active approval.</p> : result === undefined && error === undefined ? <><p>Review the approval above, then execute the one authorized GitHub write.</p><button className="primary-action" disabled={submitting} onClick={onPublish} type="button">{submitting ? "Publishing exact action…" : action.action === "push_branch" ? "Push approved branch" : "Create approved pull request"}</button></> : null}
    {result === undefined || error !== undefined ? null : <PublicationResultView action={action} result={result} />}
    {error === "unknown" ? <div className="campaign-error" role="alert"><strong>Publication outcome unknown.</strong> The provider did not prove whether the write completed. Reconciliation is required; execution is locked until authoritative campaign facts are reconciled.</div> : error === "generic" ? <p className="campaign-error" role="alert">The approved action was not published. Refresh campaign facts before retrying.</p> : null}
  </section>;
}

function PublicationResultView({ action, result }: { readonly action: ApprovedPublicationAction; readonly result: PublicationResult }) {
  if (action.action === "push_branch" && "commitSha" in result) return <div className="publication-result" role="status"><strong>Branch published</strong><p><span className="mono">{action.branch}</span> now points to the canonical commit <span className="mono">{result.commitSha}</span>.</p></div>;
  if (action.action === "create_pr" && "pullRequest" in result) return <div className="publication-result" role="status"><strong>Pull request opened</strong><p><a href={result.pullRequest} rel="noreferrer" target="_blank">View canonical pull request</a></p><p className="mono">{result.pullRequest}</p></div>;
  return <p className="campaign-error" role="alert">The provider returned a result for a different action. Publication is locked pending reconciliation.</p>;
}
