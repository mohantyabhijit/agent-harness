import { Component, useCallback, useState, type ReactNode } from "react";

import { OpenQuestTrueForgeUI } from "./OpenQuestTrueForgeUI.js";

export function DiscoveryAgentWorkspace({ operatorCapability }: { readonly operatorCapability?: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const handleError = useCallback(() => { setFailed(true); }, []);

  return <section aria-labelledby="native-chat-heading" className="native-chat">
    <h2 className="sr-only" id="native-chat-heading">Chat with OpenQuest</h2>
    {failed ? <div className="native-chat__fallback" role="alert"><strong>TrueForge chat could not connect.</strong><p>The category shortcuts below still use the validated OpenQuest discovery path.</p></div> : null}
    <div className="trueforge-frame discovery-chat__frame">
      <NativeChatBoundary onError={handleError}>
        <OpenQuestTrueForgeUI layout="thread" onError={handleError} operatorCapability={operatorCapability} />
      </NativeChatBoundary>
    </div>
  </section>;
}

class NativeChatBoundary extends Component<{ readonly children: ReactNode; readonly onError: () => void }, { readonly failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: true } { return { failed: true }; }

  componentDidCatch(): void { this.props.onError(); }

  render(): ReactNode { return this.state.failed ? null : this.props.children; }
}
