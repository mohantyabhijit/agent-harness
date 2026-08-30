import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenQuestApi, SpaceOption } from "../api.js";
import { DiscoveryAgentChat } from "../components/DiscoveryAgentChat.js";
import { SpaceCard } from "../components/SpaceCard.js";

interface OnboardingPageProps {
  readonly api: Pick<OpenQuestApi, "getSpaces" | "classifyDiscoveryIntent">;
  readonly navigate: (destination: string) => void;
}

export function OnboardingPage({ api, navigate }: OnboardingPageProps) {
  const [availableSpaces, setAvailableSpaces] = useState<readonly SpaceOption[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const selectedRef = useRef(false);

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
    selectedRef.current = true;
    const query = new URLSearchParams({ spaces: space });
    const destination = `/discover?${query.toString()}`;
    navigate(destination);
  };

  return (
    <main className="onboarding-shell">
      <section className="onboarding-hero" aria-labelledby="onboarding-title">
        <p className="wordmark">OPENQUEST</p>
        <p className="eyebrow">Your contribution mixtape</p>
        <h1 id="onboarding-title" tabIndex={-1}>What kind of open source pulls you in?</h1>
        <p>Talk naturally with OpenQuest or use a category as a quick start. Every recommendation is checked against live GitHub evidence.</p>
      </section>
      <DiscoveryAgentChat api={api} onSelect={(space) => { if (!selectedRef.current) selectSpace(space); }} />
      {status === "loading" ? <p aria-live="polite">Loading open-source spaces…</p> : null}
      {status === "error" ? <section className="state-card" role="alert"><p>We could not load spaces.</p><button onClick={loadSpaces} type="button">Try again</button></section> : null}
      {status === "ready" ? (
        <>
          <p className="choice-divider">Or choose a category for immediate structured discovery.</p>
          <fieldset className="space-grid">
            <legend>Choose a category</legend>
            {availableSpaces.map((space) => <SpaceCard key={space.id} onSelect={selectSpace} space={space} />)}
          </fieldset>
          {availableSpaces.length === 0 ? <p className="state-card">No spaces are available yet. Please try again later.</p> : null}
        </>
      ) : null}
    </main>
  );
}
