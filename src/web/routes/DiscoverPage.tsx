import { useCallback, useEffect, useState } from "react";

import type { DiscoveredRepository } from "../../application/discover.js";
import { classifyIssue, type IssueCandidate, type Space } from "../../domain/discovery.js";
import type { OpenQuestApi } from "../api.js";
import { IssueCard } from "../components/IssueCard.js";
import { RepositoryCard } from "../components/RepositoryCard.js";

interface DiscoverPageProps {
  readonly api: Pick<OpenQuestApi, "discoverRepositories" | "getIssues" | "createCampaign">;
  readonly spaces: readonly Space[];
  readonly navigate: (destination: string) => void;
}

interface IssueLoad {
  readonly repository: string;
  readonly issues: readonly IssueCandidate[];
  readonly error: boolean;
}

export function DiscoverPage({ api, spaces, navigate }: DiscoverPageProps) {
  const [repositories, setRepositories] = useState<readonly DiscoveredRepository[]>([]);
  const [issueLoads, setIssueLoads] = useState<readonly IssueLoad[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [startingIssue, setStartingIssue] = useState<string>();
  const [campaignError, setCampaignError] = useState<string>();

  const loadDiscovery = useCallback(() => {
    if (spaces.length === 0) {
      setStatus("ready");
      setRepositories([]);
      setIssueLoads([]);
      return;
    }
    setStatus("loading");
    setCampaignError(undefined);
    void api.discoverRepositories([...new Set(spaces)]).then(
      async (found) => {
        setRepositories(found);
        const loadedIssues = await Promise.all(found.map(async ({ repository }) => {
          try {
            return { repository: repository.fullName, issues: await api.getIssues(repository.fullName), error: false };
          } catch {
            return { repository: repository.fullName, issues: [], error: true };
          }
        }));
        setIssueLoads(loadedIssues);
        setStatus("ready");
      },
      () => {
        setStatus("error");
      },
    );
  }, [api, spaces]);

  useEffect(() => {
    const task = window.setTimeout(loadDiscovery, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [loadDiscovery]);

  const startCampaign = async (issue: IssueCandidate, lane: "easy_win" | "long_term") => {
    const identity = `${issue.repository}#${String(issue.number)}`;
    setStartingIssue(identity);
    setCampaignError(undefined);
    try {
      const campaign = await api.createCampaign({ repository: issue.repository, issueNumber: issue.number, issueUrl: issue.url, lane });
      navigate(`/campaigns/${campaign.id}`);
    } catch {
      setCampaignError("We could not start that campaign. Please try again.");
    } finally {
      setStartingIssue(undefined);
    }
  };

  const issues = issueLoads.flatMap(({ issues: found }) => found);
  const easyWins = issues.filter((issue) => classifyIssue(issue) === "easy_win");
  const longTermChallenges = issues.filter((issue) => classifyIssue(issue) === "long_term");

  return (
    <main className="discover-shell">
      <header className="discover-header">
        <p className="wordmark">OPENQUEST</p>
        <p className="eyebrow">Selected spaces · {spaces.map((space) => space.replaceAll("_", " ")).join(", ") || "none"}</p>
        <h1>Find a project worth your next pull request.</h1>
        <p>Every recommendation pairs visibility with evidence that a contribution can be thoughtfully reviewed.</p>
      </header>
      {status === "loading" ? <p aria-live="polite">Finding contribution-ready repositories…</p> : null}
      {status === "error" ? <section className="state-card" role="alert"><p>We could not load recommendations.</p><button onClick={loadDiscovery} type="button">Try again</button></section> : null}
      {status === "ready" && repositories.length === 0 ? <section className="state-card"><h2>No recommendations yet</h2><p>Try choosing another space or return when the catalog has fresh evidence.</p></section> : null}
      {status === "ready" && repositories.length > 0 ? (
        <>
          <section aria-labelledby="repositories-title">
            <div className="section-heading"><p className="eyebrow">Ranked with evidence</p><h2 id="repositories-title">Popular and contribution-ready</h2></div>
            <div className="repository-list">{repositories.map((repository) => <RepositoryCard key={repository.repository.fullName} repository={repository} />)}</div>
          </section>
          {issueLoads.filter(({ error }) => error).map(({ repository }) => <p className="partial-warning" key={repository} role="status">Issues for {repository} could not be loaded. Repository evidence remains available.</p>)}
          {campaignError !== undefined ? <p className="campaign-error" role="alert">{campaignError}</p> : null}
          <section className="lane" aria-labelledby="easy-wins-title">
            <div className="section-heading"><p className="eyebrow">Start here</p><h2 id="easy-wins-title">Easy Wins</h2><p>Clear scope, contained changes, and focused verification.</p></div>
            {easyWins.length === 0 ? <p>No easy wins are available from the current evidence.</p> : <div className="issue-grid">{easyWins.map((issue) => <IssueCard issue={issue} key={`${issue.repository}-${String(issue.number)}`} lane="easy_win" onSelect={(selectedIssue, selectedLane) => { void startCampaign(selectedIssue, selectedLane); }} starting={startingIssue === `${issue.repository}#${String(issue.number)}`} />)}</div>}
          </section>
          <section className="lane" aria-labelledby="long-term-title">
            <div className="section-heading"><p className="eyebrow">Go deeper</p><h2 id="long-term-title">Long-Term Challenges</h2><p>Multi-area work that benefits from milestones and durable context.</p></div>
            {longTermChallenges.length === 0 ? <p>No long-term challenges are available from the current evidence.</p> : <div className="issue-grid">{longTermChallenges.map((issue) => <IssueCard issue={issue} key={`${issue.repository}-${String(issue.number)}`} lane="long_term" onSelect={(selectedIssue, selectedLane) => { void startCampaign(selectedIssue, selectedLane); }} starting={startingIssue === `${issue.repository}#${String(issue.number)}`} />)}</div>}
          </section>
        </>
      ) : null}
    </main>
  );
}
