import { Component, useCallback, useState, type ReactNode } from "react";
import { OpenQuestTrueForgeUI } from "./OpenQuestTrueForgeUI.js";

interface OpenQuestAgentThreadProps { readonly sessionId: string; readonly trueForgeBaseUrl?: string; }

export function OpenQuestAgentThread({ sessionId, trueForgeBaseUrl }: OpenQuestAgentThreadProps) {
  const [error, setError] = useState(false);
  const handleError = useCallback(() => { setError(true); }, []);
  return <section aria-labelledby="agent-thread-heading" className="campaign-panel agent-thread" data-session-id={sessionId} data-testid="agent-thread">
    <div className="panel-heading">
      <div><p className="eyebrow">Live workspace</p><h2 id="agent-thread-heading">OpenQuest agent</h2></div>
      <span className="status-pill">Campaign session</span>
    </div>
    <p>The agent workspace resumes the campaign’s parent session. Durable evidence and decisions remain in the campaign record beside it.</p>
    {error ? <p className="campaign-error" role="alert">The agent workspace could not connect. Campaign facts and approvals remain available.</p> : null}
    <div className="trueforge-frame">
      <AgentWorkspaceBoundary key={sessionId} onError={handleError}>
        <OpenQuestTrueForgeUI
          initialSessionId={sessionId}
          onError={handleError}
          {...(trueForgeBaseUrl === undefined ? {} : { trueForgeBaseUrl })}
        />
      </AgentWorkspaceBoundary>
    </div>
  </section>;
}

class AgentWorkspaceBoundary extends Component<{ readonly children: ReactNode; readonly onError: () => void }, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: true } { return { failed: true }; }

  componentDidCatch(): void { this.props.onError(); }

  render(): ReactNode { return this.state.failed ? null : this.props.children; }
}
