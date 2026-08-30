import { useCallback, useEffect, useRef, useState } from "react";

import type { DiscoveredRepository } from "../../application/discover.js";
import { classifyIssue, type IssueCandidate, type Space } from "../../domain/discovery.js";
import { OpenQuestApiError, type DiscoveryResponse, type OpenQuestApi } from "../api.js";
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
  readonly status: "loading" | "ready" | "error";
  readonly metadata?: Pick<DiscoveryResponse<IssueCandidate>, "verifiedAt" | "source" | "refreshing">;
}

export function DiscoverPage({ api, spaces, navigate }: DiscoverPageProps) {
  const [repositories, setRepositories] = useState<readonly DiscoveredRepository[]>([]);
  const [discoveryMetadata, setDiscoveryMetadata] = useState<Pick<DiscoveryResponse<DiscoveredRepository>, "verifiedAt" | "source" | "refreshing">>();
  const [issueLoads, setIssueLoads] = useState<readonly IssueLoad[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [slow, setSlow] = useState(false);
  const [errorCode, setErrorCode] = useState<string>();
  const [startingIssue, setStartingIssue] = useState<string>();
  const [campaignError, setCampaignError] = useState<string>();
  const discoveryController = useRef<AbortController | undefined>(undefined);
  const slowTimer = useRef<number | undefined>(undefined);
  const discoveryGeneration = useRef(0);
  const campaignController = useRef<AbortController | undefined>(undefined);
  const campaignActive = useRef(false);
  const issueControllers = useRef(new Map<string, AbortController>());
  const issueGenerations = useRef(new Map<string, number>());

  const loadIssuesForRepository = useCallback((repository: string, discoveryRequest: number) => {
    issueControllers.current.get(repository)?.abort();
    const controller = new AbortController();
    issueControllers.current.set(repository, controller);
    const request = (issueGenerations.current.get(repository) ?? 0) + 1;
    issueGenerations.current.set(repository, request);
    setIssueLoads((current) => current.map((entry) => entry.repository === repository ? { ...entry, status: "loading" } : entry));
    void api.getIssues(repository, controller.signal).then(
      (response) => {
        if (discoveryGeneration.current !== discoveryRequest || issueGenerations.current.get(repository) !== request) return;
        setIssueLoads((current) => current.map((entry) => entry.repository === repository ? { ...entry, issues: response.values, metadata: response, status: "ready" } : entry));
      },
      () => {
        if (discoveryGeneration.current !== discoveryRequest || issueGenerations.current.get(repository) !== request || controller.signal.aborted) return;
        setIssueLoads((current) => current.map((entry) => entry.repository === repository ? { ...entry, status: "error" } : entry));
      },
    );
  }, [api]);

  const loadDiscovery = useCallback(() => {
    discoveryController.current?.abort();
    if (slowTimer.current !== undefined) window.clearTimeout(slowTimer.current);
    const controller = new AbortController();
    discoveryController.current = controller;
    const generation = discoveryGeneration.current + 1;
    discoveryGeneration.current = generation;
    if (spaces.length === 0) {
      setStatus("ready");
      setRepositories([]);
      setIssueLoads([]);
      return;
    }
    setStatus("loading");
    setSlow(false);
    setErrorCode(undefined);
    setCampaignError(undefined);
    slowTimer.current = window.setTimeout(() => { setSlow(true); }, 8_000);
    void api.discoverRepositories([...new Set(spaces)], controller.signal).then(
      (response) => {
        if (slowTimer.current !== undefined) window.clearTimeout(slowTimer.current);
        if (discoveryGeneration.current !== generation) return;
        const unique = response.values.filter((item, index, all) => all.findIndex(({ repository }) => repository.fullName === item.repository.fullName) === index);
        setDiscoveryMetadata(response);
        setRepositories(unique);
        setIssueLoads(unique.map(({ repository }) => ({ repository: repository.fullName, issues: [], status: "loading" })));
        setStatus("ready");
        for (const item of unique) loadIssuesForRepository(item.repository.fullName, generation);
      },
      (error: unknown) => {
        if (slowTimer.current !== undefined) window.clearTimeout(slowTimer.current);
        if (discoveryGeneration.current !== generation || controller.signal.aborted) return;
        setErrorCode(error instanceof OpenQuestApiError ? error.code : undefined);
        setStatus("error");
      },
    );
  }, [api, loadIssuesForRepository, spaces]);

  useEffect(() => {
    const task = window.setTimeout(loadDiscovery, 0);
    const controllers = issueControllers.current;
    return () => {
      window.clearTimeout(task);
      if (slowTimer.current !== undefined) window.clearTimeout(slowTimer.current);
      discoveryController.current?.abort();
      for (const controller of controllers.values()) controller.abort();
      const controller = campaignController.current;
      controller?.abort();
      if (campaignController.current === controller) campaignController.current = undefined;
    };
  }, [loadDiscovery]);

  const startCampaign = async (issue: IssueCandidate, lane: "easy_win" | "long_term") => {
    if (campaignActive.current) return;
    campaignActive.current = true;
    campaignController.current?.abort();
    const controller = new AbortController();
    campaignController.current = controller;
    const identity = `${issue.repository}#${String(issue.number)}`;
    setStartingIssue(identity);
    setCampaignError(undefined);
    try {
      const campaign = await api.createCampaign({ repository: issue.repository, issueNumber: issue.number, issueUrl: issue.url, lane }, controller.signal);
      if (campaignController.current !== controller) return;
      navigate(`/campaigns/${encodeURIComponent(campaign.id)}`);
    } catch {
      setCampaignError("We could not start that campaign. Please try again.");
    } finally {
      setStartingIssue(undefined);
      campaignActive.current = false;
    }
  };

  const issues = issueLoads.flatMap(({ issues: found }) => found);
  const issuesAreLoading = issueLoads.some(({ status: issueStatus }) => issueStatus === "loading");
  const easyWins = issues.filter((issue) => classifyIssue(issue) === "easy_win");
  const longTermChallenges = issues.filter((issue) => classifyIssue(issue) === "long_term");

  return (
    <main className="discover-shell">
      <nav aria-label="Product" className="product-nav">
        <button className="brand brand--button" onClick={() => { navigate("/"); }} type="button"><img alt="" height="28" src={`${import.meta.env.BASE_URL}openquest-mark.svg`} width="28" /><span>OpenQuest</span></button>
        <button className="back-link" onClick={() => { navigate("/"); }} type="button">Back to chat</button>
      </nav>
      <header className="discover-header">
        <p className="eyebrow">Selected category · {spaces.map((space) => space.replaceAll("_", " ")).join(", ") || "none"}</p>
        <h1 tabIndex={-1}>Find your next contribution.</h1>
        <p>Every recommendation pairs visibility with evidence that a contribution can be thoughtfully reviewed.</p>
        <p className="evidence-mode" role="status"><strong>{discoveryMetadata?.source === "snapshot" ? "Verified snapshot" : "Live verification"}</strong>{discoveryMetadata?.refreshing ? " · refreshing live evidence in background" : " · read-only GitHub evidence"}{discoveryMetadata?.verifiedAt ? ` · verified ${new Date(discoveryMetadata.verifiedAt).toLocaleString()}` : ""} · no external writes</p>
      </header>
      {status === "loading" ? <section aria-live="polite" className="loading-state"><div className="loading-grid" aria-hidden="true"><span className="skeleton-card" /><span className="skeleton-card" /><span className="skeleton-card" /></div><p className="loading-status">{slow ? "Still verifying live GitHub evidence. This can take about a minute." : "Starting a read-only TrueForge verification…"}</p></section> : null}
      {status === "error" ? <section className="state-card" role="alert"><h2>Verification did not finish</h2><p>{errorCode === "harness_unavailable" ? "TrueForge could not complete a fully verified set. No unverified recommendations were shown." : "We could not load verified recommendations. No unverified results were shown."}</p><div className="error-actions"><button onClick={loadDiscovery} type="button">Try again</button><button className="secondary-action" onClick={() => { navigate("/"); }} type="button">Back to chat</button></div></section> : null}
      {status === "ready" && repositories.length === 0 ? <section className="state-card"><h2>No recommendations yet</h2><p>Try choosing another space or return when the catalog has fresh evidence.</p></section> : null}
      {status === "ready" && repositories.length > 0 ? (
        <>
          <section aria-labelledby="repositories-title">
            <div className="section-heading"><p className="eyebrow">Ranked with evidence</p><h2 id="repositories-title">Popular and contribution-ready</h2></div>
            <div className="repository-list">{repositories.map((repository) => <RepositoryCard key={repository.repository.fullName} repository={repository} />)}</div>
          </section>
          {issueLoads.filter(({ status: issueStatus }) => issueStatus === "error").map(({ repository }) => <p className="partial-warning" key={repository} role="status">Issues for {repository} could not be loaded. Repository evidence remains available. <button onClick={() => { loadIssuesForRepository(repository, discoveryGeneration.current); }} type="button">Retry issues</button></p>)}
          {issueLoads.filter(({ status: issueStatus }) => issueStatus === "loading").map(({ repository }) => <p key={repository} role="status">Loading contribution issues for {repository}…</p>)}
          {campaignError !== undefined ? <p className="campaign-error" role="alert">{campaignError}</p> : null}
          <section className="lane" aria-labelledby="easy-wins-title">
            <div className="section-heading"><p className="eyebrow">Start here</p><h2 id="easy-wins-title">Easy Wins</h2><p>Clear scope, contained changes, and focused verification.</p></div>
            {easyWins.length > 0 ? <div className="issue-grid">{easyWins.map((issue) => <IssueCard issue={issue} key={`${issue.repository}-${String(issue.number)}`} lane="easy_win" onSelect={(selectedIssue, selectedLane) => { void startCampaign(selectedIssue, selectedLane); }} starting={startingIssue !== undefined} />)}</div> : null}
            {issuesAreLoading ? <p role="status">Loading Easy Wins…</p> : easyWins.length === 0 ? <p>No easy wins are available from the current evidence.</p> : null}
          </section>
          <section className="lane" aria-labelledby="long-term-title">
            <div className="section-heading"><p className="eyebrow">Go deeper</p><h2 id="long-term-title">Long-Term Challenges</h2><p>Multi-area work that benefits from milestones and durable context.</p></div>
            {longTermChallenges.length > 0 ? <div className="issue-grid">{longTermChallenges.map((issue) => <IssueCard issue={issue} key={`${issue.repository}-${String(issue.number)}`} lane="long_term" onSelect={(selectedIssue, selectedLane) => { void startCampaign(selectedIssue, selectedLane); }} starting={startingIssue !== undefined} />)}</div> : null}
            {issuesAreLoading ? <p role="status">Loading Long-Term Challenges…</p> : longTermChallenges.length === 0 ? <p>No long-term challenges are available from the current evidence.</p> : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
