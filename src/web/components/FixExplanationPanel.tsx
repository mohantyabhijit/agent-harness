import type { CampaignSnapshot } from "../api.js";

export function FixExplanationPanel({ explanation }: { readonly explanation: NonNullable<CampaignSnapshot["fixExplanation"]> }) {
  return <section className="campaign-panel" aria-labelledby="fix-explanation-heading">
    <p className="eyebrow">Verified implementation</p>
    <h2 id="fix-explanation-heading">What changed and why</h2>
    <dl>
      <dt>Before</dt><dd>{explanation.before}</dd>
      <dt>After</dt><dd>{explanation.after}</dd>
      <dt>Changed areas</dt><dd><ul>{explanation.changedAreas.map((area) => <li key={area}>{area}</li>)}</ul></dd>
      <dt>Tests</dt><dd><ul>{explanation.tests.map((test) => <li key={test}>{test}</li>)}</ul></dd>
      <dt>Uncertainty</dt><dd>{explanation.uncertainty}</dd>
      <dt>Commit</dt><dd><code>{explanation.commitSha}</code></dd>
    </dl>
  </section>;
}
