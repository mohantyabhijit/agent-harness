import { useEffect, useMemo, useState } from "react";

import { createOpenQuestApi, type OpenQuestApi, type OpenQuestApiOptions } from "./api.js";
import { DiscoverPage } from "./routes/DiscoverPage.js";
import { CampaignPage } from "./routes/CampaignPage.js";
import { OnboardingPage } from "./routes/OnboardingPage.js";
import { isKnownSpace, type Space } from "../domain/discovery.js";

interface AppProps {
  readonly api?: OpenQuestApi;
  readonly operatorCapability?: OpenQuestApiOptions["operatorCapability"];
}

export function App({ api, operatorCapability }: AppProps) {
  const [enteredCapability, setEnteredCapability] = useState("");
  const [connected, setConnected] = useState(operatorCapability !== undefined || import.meta.env.DEV);
  const developmentProxyCapability = useMemo(
    () => import.meta.env.DEV ? () => "openquest-local-proxy" : undefined,
    [],
  );
  const activeCapability = useMemo(
    () => operatorCapability ?? developmentProxyCapability ?? (connected ? () => enteredCapability : undefined),
    [connected, developmentProxyCapability, enteredCapability, operatorCapability],
  );
  const browserApi = useMemo(
    () => createOpenQuestApi(
      activeCapability === undefined
        ? { fetch: window.fetch.bind(window), baseUrl: import.meta.env.BASE_URL.replace(/\/$/u, "") }
        : { fetch: window.fetch.bind(window), baseUrl: import.meta.env.BASE_URL.replace(/\/$/u, ""), operatorCapability: activeCapability },
    ),
    [activeCapability],
  );
  const client = api ?? browserApi;
  const nativeCapability = activeCapability?.();
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
    const resolved = withApplicationBase(destination);
    window.history.pushState({}, "", resolved);
    setLocation(resolved);
  };
  useEffect(() => {
    window.setTimeout(() => document.querySelector<HTMLElement>("h1")?.focus(), 0);
  }, [location, connected]);
  const [rawPath = "/"] = location.split("?");
  const path = withoutApplicationBase(rawPath);
  const selectedSpaces = spacesFromLocation();
  const disconnect = () => { setEnteredCapability(""); setConnected(false); navigate("/"); };
  const access = api === undefined && !connected ? <OperatorAccess enteredCapability={enteredCapability} onChange={setEnteredCapability} onConnect={() => { setConnected(true); }} /> : null;
  const sessionAction = api === undefined && connected && developmentProxyCapability === undefined ? <button className="session-action" onClick={disconnect} type="button">Disconnect</button> : null;
  if (path === "/discover" && selectedSpaces.length > 0) return <>{access}{sessionAction}<DiscoverPage api={client} navigate={navigate} spaces={selectedSpaces} /></>;
  const campaignId = campaignIdFromPath(path);
  if (campaignId !== undefined) return <>{access}{sessionAction}<CampaignPage api={client} campaignId={campaignId} key={campaignId} operatorCapability={nativeCapability} /></>;
  return <>{access}{sessionAction}{path === "/discover" ? <p className="state-card" role="status">Choose a focus before discovering repositories.</p> : null}<OnboardingPage api={client} navigate={navigate} operatorCapability={nativeCapability} /></>;
}

function applicationBase(): string { return import.meta.env.BASE_URL.replace(/\/$/u, ""); }

function withApplicationBase(destination: string): string {
  const base = applicationBase();
  if (base === "" || destination === base || destination.startsWith(`${base}/`)) return destination;
  return `${base}${destination.startsWith("/") ? destination : `/${destination}`}`;
}

function withoutApplicationBase(path: string): string {
  const base = applicationBase();
  if (base === "" || path === base) return path === base && base !== "" ? "/" : path;
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

function OperatorAccess({ enteredCapability, onChange, onConnect }: { readonly enteredCapability: string; readonly onChange: (value: string) => void; readonly onConnect: () => void }) {
  return <aside aria-label="Operator access" className="operator-access">
    <div><strong>Operator access needed</strong><span>Connect to run verified discovery.</span></div>
    <label className="sr-only" htmlFor="operator-capability">Operator capability</label>
    <input autoComplete="off" id="operator-capability" onChange={(event) => { onChange(event.target.value); }} placeholder="Capability" type="password" value={enteredCapability} />
    <button disabled={enteredCapability.trim() === ""} onClick={onConnect} type="button">Connect</button>
  </aside>;
}

function campaignIdFromPath(path: string): string | undefined {
  const match = /^\/campaigns\/([^/]+)$/u.exec(path);
  if (match?.[1] === undefined) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

function spacesFromLocation(): readonly Space[] {
  const values = new URLSearchParams(window.location.search).get("spaces")?.split(",") ?? [];
  if (values.length !== 1 || values[0] === undefined || !isKnownSpace(values[0])) return [];
  return values as readonly Space[];
}
