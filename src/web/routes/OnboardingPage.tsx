import { useCallback, useEffect, useState } from "react";

import type { OpenQuestApi, SpaceOption } from "../api.js";
import { SpaceCard } from "../components/SpaceCard.js";

interface OnboardingPageProps {
  readonly api: Pick<OpenQuestApi, "getSpaces">;
  readonly navigate: (destination: string) => void;
}

export function OnboardingPage({ api, navigate }: OnboardingPageProps) {
  const [availableSpaces, setAvailableSpaces] = useState<readonly SpaceOption[]>([]);
  const [selectedSpaces, setSelectedSpaces] = useState<ReadonlySet<string>>(() => selectedFromLocation());
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const loadSpaces = useCallback(() => {
    setStatus("loading");
    void api.getSpaces().then(
      (spaces) => {
        setAvailableSpaces(spaces);
        setSelectedSpaces((selected) => new Set([...selected].filter((space) => spaces.some(({ id }) => id === space))));
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

  const toggleSpace = (space: string) => {
    setSelectedSpaces((selected) => {
      const next = new Set(selected);
      if (next.has(space)) next.delete(space);
      else next.add(space);
      return next;
    });
  };
  const continueToDiscovery = () => {
    const selected = availableSpaces.map(({ id }) => id).filter((id) => selectedSpaces.has(id));
    const query = new URLSearchParams({ spaces: selected.join(",") });
    const destination = `/discover?${query.toString()}`;
    window.history.replaceState({}, "", destination);
    navigate(destination);
  };

  return (
    <main className="onboarding-shell">
      <section className="onboarding-hero" aria-labelledby="onboarding-title">
        <p className="wordmark">OPENQUEST</p>
        <p className="eyebrow">Your contribution mixtape</p>
        <h1 id="onboarding-title">What kind of open source pulls you in?</h1>
        <p>Choose as many spaces as you like. We will match recognition with the evidence that a project welcomes new contributors.</p>
      </section>
      {status === "loading" ? <p aria-live="polite">Loading open-source spaces…</p> : null}
      {status === "error" ? <section className="state-card" role="alert"><p>We could not load spaces.</p><button onClick={loadSpaces} type="button">Try again</button></section> : null}
      {status === "ready" ? (
        <>
          <fieldset className="space-grid">
            <legend>Choose one or more spaces</legend>
            {availableSpaces.map((space) => <SpaceCard key={space.id} onToggle={toggleSpace} selected={selectedSpaces.has(space.id)} space={space} />)}
          </fieldset>
          {availableSpaces.length === 0 ? <p className="state-card">No spaces are available yet. Please try again later.</p> : null}
          <button className="primary-action" disabled={selectedSpaces.size === 0} onClick={continueToDiscovery} type="button">Continue to discovery</button>
        </>
      ) : null}
    </main>
  );
}

function selectedFromLocation(): ReadonlySet<string> {
  const value = new URLSearchParams(window.location.search).get("spaces");
  return new Set(value?.split(",").filter((space) => space !== "") ?? []);
}
