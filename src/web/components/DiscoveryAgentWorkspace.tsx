import { Component, useCallback, useState, type ReactNode } from "react";

import { OpenQuestTrueForgeUI } from "./OpenQuestTrueForgeUI.js";

export function DiscoveryAgentWorkspace({ operatorCapability }: { readonly operatorCapability?: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const handleError = useCallback(() => { setFailed(true); }, []);

  return <section aria-labelledby="native-chat-heading" className="native-chat">
    <div className="native-chat__header">
      <div>
        <p className="eyebrow">TrueForge native workspace</p>
        <h2 id="native-chat-heading">Tell OpenQuest what you want to build</h2>
      </div>
      <span className="live-badge"><span aria-hidden="true" />Native runtime</span>
    </div>
    <p className="native-chat__intro">Chat naturally with the registered OpenQuest agent. It can narrow your interests to one safe contribution category; verified repository cards are loaded separately after you choose that focus.</p>
    {failed ? <div className="native-chat__fallback" role="alert"><strong>TrueForge chat could not connect.</strong><p>The category shortcuts below still use the validated OpenQuest discovery path.</p></div> : null}
    <div className="trueforge-frame discovery-chat__frame">
      <NativeChatBoundary onError={handleError}>
        <OpenQuestTrueForgeUI layout="dock" onError={handleError} operatorCapability={operatorCapability} />
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
