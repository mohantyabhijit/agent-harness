import { Component, useCallback, useState, type ReactNode } from "react";
import { OpenQuestTrueForgeUI } from "./OpenQuestTrueForgeUI.js";

interface DiscoveryAgentChatProps { readonly trueForgeBaseUrl?: string; }
interface ChatErrorBoundaryProps { readonly children: ReactNode; }
interface ChatErrorBoundaryState { readonly failed: boolean; }

function ChatUnavailable() {
  return <p className="campaign-error" role="alert">The discovery chat could not connect. You can still choose a category below.</p>;
}

class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  override state: ChatErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChatErrorBoundaryState { return { failed: true }; }

  override render() {
    return this.state.failed
      ? <ChatUnavailable />
      : this.props.children;
  }
}

export function DiscoveryAgentChat({ trueForgeBaseUrl }: DiscoveryAgentChatProps) {
  const [started, setStarted] = useState(false);
  const [error, setError] = useState(false);
  const handleError = useCallback(() => { setError(true); }, []);

  return <section aria-labelledby="discovery-chat-heading" className="discovery-chat">
    <div className="section-heading">
      <p className="eyebrow">Conversation-first discovery</p>
      <h2 id="discovery-chat-heading">Talk to OpenQuest</h2>
      <p>Describe what you want to contribute to in your own words. OpenQuest searches GitHub live and explains why each project may welcome an outside contributor.</p>
    </div>
    {!started ? <button className="primary-action" onClick={() => { setStarted(true); }} type="button">Start talking to OpenQuest</button> : error ? <ChatUnavailable /> : <ChatErrorBoundary>
        <div className="trueforge-frame discovery-chat__frame">
          <OpenQuestTrueForgeUI
            onError={handleError}
            {...(trueForgeBaseUrl === undefined ? {} : { trueForgeBaseUrl })}
          />
        </div>
      </ChatErrorBoundary>}
  </section>;
}
