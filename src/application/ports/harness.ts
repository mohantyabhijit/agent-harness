export interface CampaignPacket {
  campaignId: string;
  repository: string;
  issueNumber: number;
  goal: string;
  verifiedEvidence: readonly { sourceUrl: string; observation: string }[];
  approvals: readonly { action: string; digest: string; status: string }[];
}

export type HarnessOperation =
  | "discover"
  | "policy"
  | "preflight"
  | "implement"
  | "verify"
  | "sync_qodo"
  | "repair";

export interface HarnessSessionResult {
  sessionId: string;
  summary: string;
  artifacts: readonly string[];
  output: unknown;
}

export interface HarnessPort {
  createParentSession(title: string): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  runChildSession(packet: CampaignPacket, operation: HarnessOperation): Promise<HarnessSessionResult>;
  streamSession(
    sessionId: string,
    packet: CampaignPacket,
    operation: HarnessOperation,
  ): Promise<AsyncIterable<unknown>>;
  getSessionEvents(sessionId: string): Promise<readonly unknown[]>;
}
