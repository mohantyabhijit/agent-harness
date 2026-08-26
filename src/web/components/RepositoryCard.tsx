import type { DiscoveredRepository } from "../../application/discover.js";

interface RepositoryCardProps {
  readonly repository: DiscoveredRepository;
}

export function RepositoryCard({ repository: discovered }: RepositoryCardProps) {
  const { repository, score, explanation } = discovered;
  const retrievedAt = explanation.retrievedAt[0] ?? repository.evidence[0]?.retrievedAt;

  return (
    <article className="repository-card" aria-labelledby={`repository-${repository.fullName}`}>
      <div className="card-heading">
        <div>
          <p className="eyebrow">Contribution-ready pick</p>
          <h3 id={`repository-${repository.fullName}`}>{repository.fullName}</h3>
        </div>
        <span className="score" aria-label={`Readiness score ${String(Math.round(score * 100))} out of 100`}>{Math.round(score * 100)}</span>
      </div>
      <p>{repository.description}</p>
      <ul className="tag-list" aria-label="Open-source spaces">
        {repository.spaces.map((space) => <li key={space}>{space.replaceAll("_", " ")}</li>)}
      </ul>
      <dl className="signal-grid">
        <div><dt>Popularity</dt><dd>{repository.signals.stars.toLocaleString()} stars</dd></div>
        <div><dt>Activity</dt><dd>{repository.signals.recentActivity > 0 ? "Recently active" : "Needs review"}</dd></div>
        <div><dt>Contribution guide</dt><dd>{repository.signals.contributionGuide ? "Available" : "Not found"}</dd></div>
        <div><dt>External pull requests</dt><dd>{Math.round(repository.signals.externalPrAcceptance * 100)}% accepted</dd></div>
      </dl>
      <details className="evidence-details" open>
        <summary>Evidence and score explanation</summary>
        <p>Readiness balances popularity with documentation, activity, CI, maintainer response, and external pull-request acceptance.</p>
        <ul>
          {explanation.evidence.map((item) => (
            <li key={item.id}>
              <a href={item.sourceUrl} rel="noreferrer" target="_blank">{item.observation}</a>
              <span> Retrieved {formatDate(item.retrievedAt)}.</span>
            </li>
          ))}
        </ul>
      </details>
      {retrievedAt !== undefined ? <p className="freshness">Retrieved {formatDate(retrievedAt)}</p> : null}
    </article>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
