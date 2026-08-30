import { TrueForgeUI } from "@truefoundry/trueforge-ui";
import { useMemo } from "react";

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
  const agentConfig = useMemo(() => ({ mode: "SingleAgent" as const, name: "openquest" }), []);
  const server = useMemo(() => ({ type: "trueforge" as const, baseUrl }), [baseUrl]);
  const theme = useMemo(() => ({ brand: { name: "OpenQuest", logo: "/openquest-mark.svg" }, mode: "dark" as const, preset: "trueforge" as const }), []);

  return <TrueForgeUI
    agentConfig={agentConfig}
    {...(initialSessionId === undefined ? {} : { initialSessionId })}
    layout="drawer"
    onError={onError}
    server={server}
    theme={theme}
  />;
}
