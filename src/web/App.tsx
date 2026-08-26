import { useEffect, useMemo, useState } from "react";

import { createOpenQuestApi, type OpenQuestApi, type OpenQuestApiOptions } from "./api.js";
import { DiscoverPage } from "./routes/DiscoverPage.js";
import { OnboardingPage } from "./routes/OnboardingPage.js";
import type { Space } from "../domain/discovery.js";

interface AppProps {
  readonly api?: OpenQuestApi;
  readonly operatorCapability?: OpenQuestApiOptions["operatorCapability"];
}

export function App({ api, operatorCapability }: AppProps) {
  const browserApi = useMemo(
    () => createOpenQuestApi(
      operatorCapability === undefined
        ? { fetch: window.fetch.bind(window) }
        : { fetch: window.fetch.bind(window), operatorCapability },
    ),
    [operatorCapability],
  );
  const client = api ?? browserApi;
  const [location, setLocation] = useState(() => `${window.location.pathname}${window.location.search}`);

  useEffect(() => {
    const updateLocation = () => {
      setLocation(`${window.location.pathname}${window.location.search}`);
    };
    window.addEventListener("popstate", updateLocation);
    return () => {
      window.removeEventListener("popstate", updateLocation);
    };
  }, []);

  const navigate = (destination: string) => {
    window.history.pushState({}, "", destination);
    setLocation(destination);
  };
  const [path = "/"] = location.split("?");
  if (path === "/discover") return <DiscoverPage api={client} navigate={navigate} spaces={spacesFromLocation()} />;
  if (path.startsWith("/campaigns/")) return <main className="state-card"><h1>Campaign created</h1><p>Your contribution campaign is ready for its policy review.</p></main>;
  return <OnboardingPage api={client} navigate={navigate} />;
}

function spacesFromLocation(): readonly Space[] {
  const values = new URLSearchParams(window.location.search).get("spaces")?.split(",") ?? [];
  const knownSpaces: readonly Space[] = ["ai_ml", "developer_tools", "web", "mobile", "data", "infrastructure", "security", "science", "social_impact"];
  return [...new Set(values)].filter((value): value is Space => knownSpaces.includes(value as Space));
}
