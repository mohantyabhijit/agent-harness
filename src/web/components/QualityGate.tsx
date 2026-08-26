import type { CampaignSnapshot } from "../api.js";

interface QualityGateProps { readonly findings: CampaignSnapshot["qodoFindings"]; readonly iteration: number; readonly status: CampaignSnapshot["status"]; }

const severities = ["high", "medium", "low", "suggestion"] as const;

export function QualityGate({ findings, iteration, status }: QualityGateProps) {
  const open = findings.filter(({ status: findingStatus }) => findingStatus === "open");
  const qodoExhausted = iteration >= 3 && open.some(({ severity }) => severity === "high" || severity === "medium");
  return <section aria-labelledby="quality-heading" className="campaign-panel">
    <div className="panel-heading"><div><p className="eyebrow">Review loop</p><h2 id="quality-heading">Quality gate</h2></div><span className="status-pill">Iteration {iteration} of 3</span></div>
    <dl className="quality-counts">{severities.map((severity) => <div key={severity}><dt>{severity}</dt><dd>{open.filter((finding) => finding.severity === severity).length} open</dd></div>)}</dl>
    {status === "human_escalation" ? <p className="quality-escalation" role="alert"><strong>Human escalation required.</strong> {qodoExhausted ? "The automated Qodo repair limit was reached with actionable findings remaining." : "The campaign requires a human decision; no Qodo-exhaustion claim is recorded."}</p> : null}
    {findings.length === 0 ? <p>No Qodo findings are recorded for this campaign.</p> : <ul className="finding-list">{findings.map((finding) => <li key={finding.id}>
      <div><span className={`severity severity--${finding.severity}`}>{finding.severity}</span><span>{finding.status}</span></div>
      <strong>{finding.summary}</strong>
      <p>{finding.disposition ?? (finding.status === "open" ? "Disposition pending" : "Resolved")}</p>
      {finding.sourceUrl === undefined ? null : <a href={finding.sourceUrl} rel="noreferrer" target="_blank">Review finding</a>}
    </li>)}</ul>}
  </section>;
}
