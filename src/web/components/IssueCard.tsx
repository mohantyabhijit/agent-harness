import type { IssueCandidate } from "../../domain/discovery.js";

interface IssueCardProps {
  readonly issue: IssueCandidate;
  readonly lane: "easy_win" | "long_term";
  readonly starting: boolean;
  readonly onSelect: (issue: IssueCandidate, lane: "easy_win" | "long_term") => void;
}

export function IssueCard({ issue, lane, starting, onSelect }: IssueCardProps) {
  return (
    <article className="issue-card" aria-labelledby={`issue-${issue.repository}-${String(issue.number)}`}>
      <p className="eyebrow">{issue.repository} · #{issue.number}</p>
      <h3 id={`issue-${issue.repository}-${String(issue.number)}`}><a href={issue.url} rel="noreferrer" target="_blank">{issue.title}</a></h3>
      <dl className="issue-signals">
        <div><dt>Issue clarity</dt><dd>{percent(issue.clarity)}</dd></div>
        <div><dt>Estimated effort</dt><dd>{issue.estimatedHours} hours</dd></div>
        <div><dt>Affected areas</dt><dd>{issue.affectedAreas}</dd></div>
        <div><dt>Test complexity</dt><dd>{percent(issue.testComplexity)}</dd></div>
        <div><dt>Dependency risk</dt><dd>{percent(issue.dependencyRisk)}</dd></div>
      </dl>
      <p><strong>Maintainer signals:</strong> {issue.maintainerSignals.length === 0 ? "No maintainer signal was returned." : issue.maintainerSignals.join(" ")}</p>
      <button disabled={starting} onClick={() => {
        onSelect(issue, lane);
      }} type="button">
        {starting ? "Starting campaign…" : `Start with ${issue.title}`}
      </button>
    </article>
  );
}

function percent(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}
