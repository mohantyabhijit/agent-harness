import type { CampaignSnapshot } from "../api.js";

interface QualityGateProps { readonly findings: CampaignSnapshot["qodoFindings"]; readonly iteration: number; readonly status: CampaignSnapshot["status"]; readonly escalationReason: CampaignSnapshot["qualityEscalationReason"]; }

const severities = ["high", "medium", "low", "suggestion"] as const;

export function QualityGate({ findings, iteration, status, escalationReason }: QualityGateProps) {
  const open = findings.filter(({ status: findingStatus }) => findingStatus === "open");
  return <section aria-labelledby="quality-heading" className="campaign-panel">
    <div className="panel-heading"><div><p className="eyebrow">Review loop</p><h2 id="quality-heading">Quality gate</h2></div><span className="status-pill">Iteration {iteration} of 3</span></div>
    <dl className="quality-counts">{severities.map((severity) => <div key={severity}><dt>{severity}</dt><dd>{open.filter((finding) => finding.severity === severity).length} open</dd></div>)}</dl>
    {status === "human_escalation" ? <p className="quality-escalation" role="alert"><strong>Human escalation required.</strong> {escalationCopy(escalationReason)}</p> : null}
    {findings.length === 0 ? <p>No Qodo findings are recorded for this campaign.</p> : <ul className="finding-list">{findings.map((finding) => <li key={finding.id}>
      <div><span className={`severity severity--${finding.severity}`}>{finding.severity}</span><span>{finding.status}</span></div>
      <strong>{finding.summary}</strong>
      <p>{finding.disposition ?? (finding.status === "open" ? "Disposition pending" : "Resolved")}</p>
      {finding.sourceUrl === undefined ? null : <a href={finding.sourceUrl} rel="noreferrer" target="_blank">Review finding</a>}
    </li>)}</ul>}
  </section>;
}

function escalationCopy(reason: CampaignSnapshot["qualityEscalationReason"]): string {
  if (reason === null) return "No durable typed escalation reason was recorded; an operator must inspect the campaign history.";
  return ({ maximum_qodo_iterations: "The durable quality record says the three-iteration Qodo repair limit was reached.", tests_failed: "The durable quality record says verification tests failed.", repair_child_failed: "The durable quality record says the repair session failed.", repair_cancelled: "The repair session was cancelled before independent verification completed.", operation_result_not_safely_recorded: "The durable campaign record could not safely record an operation result.", operator_recovered_interrupted_operation: "An interrupted operation was recovered into human review." } as const)[reason];
}
