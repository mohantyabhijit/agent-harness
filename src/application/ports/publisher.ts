import type { AuthorizedExternalAction } from "../run-campaign.js";
import type { ExternalActionPayload } from "../external-action.js";

export type AuthorizedPublisherAction<Action extends "push_branch" | "create_pr"> =
  Omit<AuthorizedExternalAction, "action" | "payload"> & Readonly<{
    action: Action;
    payload: Extract<ExternalActionPayload, { action: Action }>;
  }>;

export interface PublisherPort {
  pushBranch(action: AuthorizedPublisherAction<"push_branch">): Promise<{ commitSha: string }>;
  createPr(action: AuthorizedPublisherAction<"create_pr">): Promise<{ pullRequest: string }>;
}
