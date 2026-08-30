import { useEffect, useMemo, useState } from "react";

import { createOpenQuestApi, type OpenQuestApi } from "./api.js";
import { DiscoverPage } from "./routes/DiscoverPage.js";
import { CampaignPage } from "./routes/CampaignPage.js";
import { OnboardingPage } from "./routes/OnboardingPage.js";
import type { Space } from "../domain/discovery.js";

interface AppProps {
  readonly api?: OpenQuestApi;
}

export function App({ api }: AppProps) {
  const browserApi = useMemo(
    () => createOpenQuestApi({ fetch: window.fetch.bind(window), baseUrl: import.meta.env.BASE_URL.replace(/\/$/u, "") }),
    [],
  );
  const client = api ?? browserApi;
  const [location, setLocation] = useState(currentAppLocation);

  useEffect(() => {
    const updateLocation = () => {
      setLocation(currentAppLocation());
    };
    window.addEventListener("popstate", updateLocation);
    return () => {
      window.removeEventListener("popstate", updateLocation);
    };
  }, []);

  const navigate = (destination: string) => {
    window.history.pushState({}, "", `${appBasePath()}${destination}`);
    setLocation(destination);
  };
  useEffect(() => {
    window.setTimeout(() => document.querySelector<HTMLElement>("h1")?.focus(), 0);
  }, [location]);
  const [path = "/"] = location.split("?");
  const selectedSpaces = spacesFromLocation();
  if (path === "/discover" && selectedSpaces.length > 0) return <DiscoverPage api={client} navigate={navigate} spaces={selectedSpaces} />;
  const campaignId = campaignIdFromPath(path);
  if (campaignId !== undefined) return <CampaignPage api={client} campaignId={campaignId} key={campaignId} />;
  return <>{path === "/discover" ? <p className="state-card" role="status">Choose spaces before discovering repositories.</p> : null}<OnboardingPage api={client} navigate={navigate} /></>;
}

function currentAppLocation(): string {
  const basePath = appBasePath();
  const path = basePath !== "" && window.location.pathname.startsWith(`${basePath}/`)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname;
  return `${path}${window.location.search}`;
}

function appBasePath(): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/u, "");
  return base === "/" ? "" : base;
}

function campaignIdFromPath(path: string): string | undefined {
  const match = /^\/campaigns\/([^/]+)$/u.exec(path);
  if (match?.[1] === undefined) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

function spacesFromLocation(): readonly Space[] {
  const values = new URLSearchParams(window.location.search).get("spaces")?.split(",") ?? [];
  const knownSpaces: readonly Space[] = ["ai_ml", "developer_tools", "web", "mobile", "data", "infrastructure", "security", "science", "social_impact"];
  return [...new Set(values)].filter((value): value is Space => knownSpaces.includes(value as Space));
}
