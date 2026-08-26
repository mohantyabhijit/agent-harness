import type { CampaignSnapshot } from "../api.js";

interface EvidencePanelProps { readonly evidence: CampaignSnapshot["evidence"]; readonly references: CampaignSnapshot["externalReferences"]; }

export function EvidencePanel({ evidence, references }: EvidencePanelProps) {
  return <section aria-labelledby="evidence-heading" className="campaign-panel">
    <div className="panel-heading"><div><p className="eyebrow">Ground truth</p><h2 id="evidence-heading">Evidence</h2></div><span className="fact-count">{evidence.length} observations</span></div>
    {evidence.length === 0 ? <p>Verified repository evidence will appear here as the campaign advances.</p> : <ul className="evidence-list">{evidence.map((item) => <li key={item.id}>
      <span className={`evidence-kind evidence-kind--${item.kind}`}>{item.kind}</span>
      <p>{item.observation}</p>
      <a href={item.sourceUrl} rel="noreferrer" target="_blank">Inspect source</a>
      <time dateTime={item.retrievedAt}>Retrieved {new Date(item.retrievedAt).toLocaleString()}</time>
    </li>)}</ul>}
    {references.length > 0 ? <details className="reference-details"><summary>Durable external references</summary><dl>{references.map((reference, index) => <div key={`${reference.kind}-${String(index)}`}><dt>{reference.kind.replaceAll("_", " ")}</dt><dd>{reference.value}</dd></div>)}</dl></details> : null}
  </section>;
}
