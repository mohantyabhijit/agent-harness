import { useCallback, useEffect, useState } from "react";

import type { OpenQuestApi, SpaceOption } from "../api.js";
import { DiscoveryAgentWorkspace } from "../components/DiscoveryAgentWorkspace.js";
import { SpaceCard } from "../components/SpaceCard.js";

interface OnboardingPageProps {
  readonly api: Pick<OpenQuestApi, "getSpaces">;
  readonly navigate: (destination: string) => void;
  readonly operatorCapability?: string | undefined;
}

export function OnboardingPage({ api, navigate, operatorCapability }: OnboardingPageProps) {
  const [availableSpaces, setAvailableSpaces] = useState<readonly SpaceOption[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const loadSpaces = useCallback(() => {
    setStatus("loading");
    void api.getSpaces().then(
      (spaces) => {
        setAvailableSpaces(spaces);
        setStatus("ready");
      },
      () => {
        setStatus("error");
      },
    );
  }, [api]);

  useEffect(() => {
    const task = window.setTimeout(loadSpaces, 0);
    return () => {
      window.clearTimeout(task);
    };
  }, [loadSpaces]);

  const selectSpace = (space: SpaceOption["id"]) => {
    const query = new URLSearchParams({ spaces: space });
    const destination = `/discover?${query.toString()}`;
    navigate(destination);
  };

  return (
    <main className="onboarding-shell">
      <header className="product-nav">
        <a aria-label="OpenQuest home" className="brand" href={import.meta.env.BASE_URL}><img alt="" height="28" src={`${import.meta.env.BASE_URL}openquest-mark.svg`} width="28" /><span>OpenQuest</span></a>
        <span className="product-nav__meta">Built on TrueForge</span>
      </header>
      <section className="onboarding-hero" aria-labelledby="onboarding-title">
        <div>
          <p className="eyebrow">Open source, matched to you</p>
          <h1 id="onboarding-title" tabIndex={-1}>Find work that is worth shipping.</h1>
          <p>Describe what you enjoy building. OpenQuest turns the conversation into source-backed repositories and contribution-ready issues—without writing to GitHub until you explicitly approve it.</p>
        </div>
        <ul className="trust-list" aria-label="OpenQuest safeguards">
          <li>Read-only discovery</li>
          <li>Evidence-backed matches</li>
          <li>Human-approved publishing</li>
        </ul>
      </section>
      <DiscoveryAgentWorkspace operatorCapability={operatorCapability} />
      {status === "loading" ? <p aria-live="polite">Loading open-source spaces…</p> : null}
      {status === "error" ? <section className="state-card" role="alert"><p>We could not load spaces.</p><button onClick={loadSpaces} type="button">Try again</button></section> : null}
      {status === "ready" ? (
        <section className="category-section" aria-labelledby="category-heading">
          <div className="section-heading section-heading--compact">
            <p className="eyebrow">Quick start</p>
            <h2 id="category-heading">Choose the focus OpenQuest should verify</h2>
            <p>Chat above for guidance, or move directly into the validated discovery flow.</p>
          </div>
          <fieldset className="space-grid">
            <legend>Choose a category</legend>
            {availableSpaces.map((space) => <SpaceCard key={space.id} onSelect={selectSpace} space={space} />)}
          </fieldset>
          {availableSpaces.length === 0 ? <p className="state-card">No spaces are available yet. Please try again later.</p> : null}
        </section>
      ) : null}
    </main>
  );
}
