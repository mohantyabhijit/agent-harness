import { useCallback, useState } from "react";
import { TrueForgeUI } from "@truefoundry/trueforge-ui";

interface OpenQuestAgentThreadProps { readonly sessionId: string; readonly trueForgeBaseUrl?: string; }

export function OpenQuestAgentThread({ sessionId, trueForgeBaseUrl }: OpenQuestAgentThreadProps) {
  const [error, setError] = useState(false);
  const resolvedTrueForgeBaseUrl = trueForgeBaseUrl ?? (
    import.meta.env.DEV ? "http://localhost:8790" : `${window.location.origin}/openquest/trueforge`
  );
  const handleError = useCallback(() => { setError(true); }, []);
  return <section aria-labelledby="agent-thread-heading" className="campaign-panel agent-thread" data-session-id={sessionId} data-testid="agent-thread">
    <div className="panel-heading">
      <div><p className="eyebrow">Live workspace</p><h2 id="agent-thread-heading">OpenQuest agent</h2></div>
      <span className="status-pill">Campaign session</span>
    </div>
    <p>The agent workspace resumes the campaign’s parent session. Durable evidence and decisions remain in the campaign record beside it.</p>
    {error ? <p className="campaign-error" role="alert">The agent workspace could not connect. Campaign facts and approvals remain available.</p> : null}
    <div className="trueforge-frame">
      <TrueForgeUI
        agentConfig={{ mode: "SingleAgent", name: "openquest" }}
        initialSessionId={sessionId}
        layout="drawer"
        onError={handleError}
        server={{ type: "trueforge", baseUrl: resolvedTrueForgeBaseUrl }}
        theme={{ brand: { name: "OpenQuest", logo: "/openquest-mark.svg" }, mode: "dark", preset: "trueforge" }}
      />
    </div>
  </section>;
}
