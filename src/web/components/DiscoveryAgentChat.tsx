import { useEffect, useRef, useState, type SyntheticEvent } from "react";

import type { DiscoveryConversationMessage } from "../../application/ports/intent-classifier.js";
import type { Space } from "../../domain/discovery.js";
import type { OpenQuestApi } from "../api.js";

interface DiscoveryAgentChatProps {
  readonly api: Pick<OpenQuestApi, "classifyDiscoveryIntent">;
  readonly onSelect: (space: Space) => void;
}

export function DiscoveryAgentChat({ api, onSelect }: DiscoveryAgentChatProps) {
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<readonly DiscoveryConversationMessage[]>([]);
  const [reply, setReply] = useState<string>();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const requestRef = useRef<AbortController | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
    };
  }, []);

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "loading") return;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    const turnHistory = history.slice(-10);
    const submittedMessage = message;
    setStatus("loading");
    setReply(undefined);
    void api.classifyDiscoveryIntent(submittedMessage, turnHistory, controller.signal).then((result) => {
      if (!mountedRef.current || controller.signal.aborted || requestRef.current !== controller) return;
      if (result.kind === "category") {
        requestRef.current = undefined;
        onSelect(result.space);
        return;
      }
      const completedTurn: readonly DiscoveryConversationMessage[] = [
        ...turnHistory,
        { role: "user", content: submittedMessage },
        { role: "assistant", content: result.question },
      ];
      setHistory(completedTurn.slice(-10));
      setMessage("");
      setReply(result.question);
      setStatus("idle");
    }, () => { if (mountedRef.current && !controller.signal.aborted && requestRef.current === controller) setStatus("error"); });
  };

  return <section aria-labelledby="discovery-chat-heading" className="discovery-chat">
    <div className="section-heading">
      <p className="eyebrow">Conversation-first discovery</p>
      <h2 id="discovery-chat-heading">Talk to OpenQuest</h2>
      <p>Describe your interests. OpenQuest returns one category or asks a clarification; verified repository discovery starts only after that handoff.</p>
    </div>
    <form className="discovery-chat__form" onSubmit={submit}>
      <label htmlFor="discovery-intent">What would you like to contribute to?</label>
      <textarea id="discovery-intent" maxLength={500} onChange={(event) => { setMessage(event.target.value); }} required rows={3} value={message} />
      <button className="primary-action" disabled={status === "loading"} type="submit">{status === "loading" ? "Asking OpenQuest…" : "Find repositories"}</button>
    </form>
    {reply === undefined ? null : <p className="discovery-chat__message discovery-chat__message--agent" role="status">{reply}</p>}
    {status === "error" ? <p className="campaign-error" role="alert">OpenQuest could not classify that request. Choose a category below or try again.</p> : null}
  </section>;
}
