import { TrueForgeUI } from "@truefoundry/trueforge-ui";

interface OpenQuestTrueForgeUIProps {
  readonly initialSessionId?: string;
  readonly onError: () => void;
  readonly trueForgeBaseUrl?: string;
}

export function OpenQuestTrueForgeUI({
  initialSessionId,
  onError,
  trueForgeBaseUrl,
}: OpenQuestTrueForgeUIProps) {
  const baseUrl = trueForgeBaseUrl ?? (
    import.meta.env.DEV ? "http://localhost:8790" : `${window.location.origin}/openquest/trueforge`
  );

  return <TrueForgeUI
    agentConfig={{ mode: "SingleAgent", name: "openquest" }}
    {...(initialSessionId === undefined ? {} : { initialSessionId })}
    layout="drawer"
    onError={onError}
    server={{ type: "trueforge", baseUrl }}
    theme={{ brand: { name: "OpenQuest", logo: "/openquest-mark.svg" }, mode: "dark", preset: "trueforge" }}
  />;
}
