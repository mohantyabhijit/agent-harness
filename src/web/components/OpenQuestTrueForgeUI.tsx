import {
  ServerProvider,
  SlotsProvider,
  Thread,
  TrueForgeUI,
  TrueFoundryChatProvider,
  type WelcomeScreenProps,
} from "@truefoundry/trueforge-ui";
import { createTrueForgeAgentUIServer } from "@truefoundry/trueforge-ui/plugins/trueforge-agent-server-adapter";
import { useMemo } from "react";

interface OpenQuestTrueForgeUIProps {
  readonly initialSessionId?: string;
  readonly layout?: "sidebar" | "drawer" | "dock" | "widget" | "thread";
  readonly onError: () => void;
  readonly operatorCapability?: string | undefined;
  readonly trueForgeBaseUrl?: string;
}

export function OpenQuestTrueForgeUI({
  initialSessionId,
  layout = "dock",
  onError,
  operatorCapability,
  trueForgeBaseUrl,
}: OpenQuestTrueForgeUIProps) {
  const baseUrl = trueForgeBaseUrl ?? (
    import.meta.env.DEV ? `${window.location.origin}/trueforge` : `${window.location.origin}/openquest/trueforge`
  );
  const agentConfig = useMemo(() => ({ mode: "SingleAgent" as const, name: "openquest" }), []);
  const server = useMemo(() => ({ type: "trueforge" as const, baseUrl, ...(operatorCapability === undefined ? {} : { token: operatorCapability }) }), [baseUrl, operatorCapability]);
  const theme = useMemo(() => ({ brand: { name: "OpenQuest", logo: `${import.meta.env.BASE_URL}openquest-mark.svg` }, mode: "light" as const, preset: "trueforge" as const }), []);

  if (initialSessionId !== undefined) {
    return <OpenQuestTrueForgeSession
      baseUrl={baseUrl}
      initialSessionId={initialSessionId}
      onError={onError}
      operatorCapability={operatorCapability}
      theme={theme}
    />;
  }

  return <TrueForgeUI
    agentConfig={agentConfig}
    layout={layout === "thread" ? SimpleChatLayout : layout}
    onError={onError}
    {...(layout === "thread" ? { overrides: { WelcomeScreen: SimpleChatWelcome } } : {})}
    server={server}
    theme={theme}
  />;
}

function SimpleChatLayout({ className }: { readonly className?: string }) {
  return <div className={["simple-chat-layout", className].filter(Boolean).join(" ")}><Thread /></div>;
}

function SimpleChatWelcome({ className }: WelcomeScreenProps) {
  return <div className={["simple-chat-welcome", className].filter(Boolean).join(" ")}>
    <strong>What would you like to build?</strong>
    <p>Describe your interests and OpenQuest will find a contribution worth making.</p>
  </div>;
}

function OpenQuestTrueForgeSession({
  baseUrl,
  initialSessionId,
  onError,
  operatorCapability,
  theme,
}: {
  readonly baseUrl: string;
  readonly initialSessionId: string;
  readonly onError: () => void;
  readonly operatorCapability?: string | undefined;
  readonly theme: { readonly brand: { readonly name: string; readonly logo: string }; readonly mode: "light"; readonly preset: "trueforge" };
}) {
  const sessionServer = useMemo(() => createTrueForgeAgentUIServer({ baseUrl, ...(operatorCapability === undefined ? {} : { token: operatorCapability }) }), [baseUrl, operatorCapability]);
  // TrueForge requires a draft seed even when an existing remote session is
  // supplied. It is used only if the runtime creates a new session; the
  // resumed campaign keeps the immutable inline policy stored by the server.
  const resumeFallbackAgent = useMemo(() => ({
    mode: "draft" as const,
    defaultAgentSpec: { model: { name: "openai/gpt-5-6-luna" } },
  }), []);

  return <SlotsProvider theme={theme}>
    <ServerProvider server={sessionServer}>
      <TrueFoundryChatProvider
        agent={resumeFallbackAgent}
        initialSessionId={initialSessionId}
        onError={onError}
        server={sessionServer}
      >
        <Thread />
      </TrueFoundryChatProvider>
    </ServerProvider>
  </SlotsProvider>;
}
