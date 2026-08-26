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
  const [enteredCapability, setEnteredCapability] = useState("");
  const [connected, setConnected] = useState(operatorCapability !== undefined);
  const activeCapability = useMemo(
    () => operatorCapability ?? (connected ? () => enteredCapability : undefined),
    [connected, enteredCapability, operatorCapability],
  );
  const browserApi = useMemo(
    () => createOpenQuestApi(
      activeCapability === undefined
        ? { fetch: window.fetch.bind(window) }
        : { fetch: window.fetch.bind(window), operatorCapability: activeCapability },
    ),
    [activeCapability],
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
  useEffect(() => {
    window.setTimeout(() => document.querySelector<HTMLElement>("h1")?.focus(), 0);
  }, [location, connected]);
  if (api === undefined && !connected) return <main className="state-card connection-card"><h1 tabIndex={-1}>Connect an operator capability</h1><p>Your capability stays only in this page's memory and is required before authenticated discovery starts.</p><label htmlFor="operator-capability">Operator capability</label><input autoComplete="off" id="operator-capability" onChange={(event) => { setEnteredCapability(event.target.value); }} type="password" value={enteredCapability} /><button disabled={enteredCapability.trim() === ""} onClick={() => { setConnected(true); }} type="button">Connect</button></main>;
  const [path = "/"] = location.split("?");
  const selectedSpaces = spacesFromLocation();
  const disconnect = () => { setEnteredCapability(""); setConnected(false); navigate("/"); };
  if (path === "/discover" && selectedSpaces.length > 0) return <><button className="disconnect" onClick={disconnect} type="button">Disconnect</button><DiscoverPage api={client} navigate={navigate} spaces={selectedSpaces} /></>;
  if (path.startsWith("/campaigns/")) return <><button className="disconnect" onClick={disconnect} type="button">Disconnect</button><main className="state-card"><h1 tabIndex={-1}>Campaign created</h1><p>Your contribution campaign is ready for its policy review.</p></main></>;
  return <><button className="disconnect" onClick={() => { setEnteredCapability(""); setConnected(false); }} type="button">Disconnect</button>{path === "/discover" ? <p className="state-card" role="status">Choose spaces before discovering repositories.</p> : null}<OnboardingPage api={client} navigate={navigate} /></>;
}

function spacesFromLocation(): readonly Space[] {
  const values = new URLSearchParams(window.location.search).get("spaces")?.split(",") ?? [];
  const knownSpaces: readonly Space[] = ["ai_ml", "developer_tools", "web", "mobile", "data", "infrastructure", "security", "science", "social_impact"];
  return [...new Set(values)].filter((value): value is Space => knownSpaces.includes(value as Space));
}
