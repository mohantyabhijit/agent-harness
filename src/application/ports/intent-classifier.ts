import type { Space } from "../../domain/discovery.js";

export interface DiscoveryConversationMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export type DiscoveryIntentResult =
  | Readonly<{ kind: "category"; space: Space }>
  | Readonly<{ kind: "clarification"; question: string }>;

export interface IntentClassifierPort {
  classify(message: string, history: readonly DiscoveryConversationMessage[]): Promise<DiscoveryIntentResult>;
}
