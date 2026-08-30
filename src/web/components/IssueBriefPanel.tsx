import type { IssueBrief } from "../../domain/issue-brief.js";

interface IssueBriefPanelProps {
  readonly brief: IssueBrief;
  readonly finalized: boolean;
  readonly onFinalize: () => void;
  readonly submitting: boolean;
}

export function IssueBriefPanel({ brief, finalized, onFinalize, submitting }: IssueBriefPanelProps) {
  return <section aria-labelledby="issue-brief-heading" className="campaign-panel issue-brief">
    <p className="eyebrow">Issue analysis</p>
    <h2 id="issue-brief-heading">Problem and proposed fix</h2>
    <h3>Problem</h3><p>{brief.problem}</p>
    <h3>Likely cause</h3><p>{brief.likelyCause}</p>
    <h3>Smallest fix</h3><p>{brief.smallestFix}</p>
    <h3>Affected areas</h3><ul>{brief.affectedAreas.map((item) => <li key={item}>{item}</li>)}</ul>
    <h3>Test plan</h3><ul>{brief.tests.map((item) => <li key={item}>{item}</li>)}</ul>
    <h3>Risks</h3><ul>{brief.risks.map((item) => <li key={item}>{item}</li>)}</ul>
    <h3>Uncertainty</h3><p>{brief.uncertainty}</p>
    <h3>Source evidence</h3><ul>{brief.evidence.map((item) => <li key={`${item.sourceUrl}-${item.observation}`}><a href={item.sourceUrl} rel="noreferrer" target="_blank">GitHub source</a> — {item.observation}</li>)}</ul>
    {finalized ? <p className="evidence-mode" role="status"><strong>Finalized</strong> · sandbox work may now begin after preflight.</p> : <><p>Discuss this analysis in the TrueForge chat. Finalizing locks these source-backed facts and enables preflight; it does not write to GitHub.</p><button className="primary-action" disabled={submitting} onClick={onFinalize} type="button">{submitting ? "Finalizing…" : "Finalize issue brief"}</button></>}
  </section>;
}
