export type ApplicationErrorCode =
  | "campaign_not_found"
  | "campaign_conflict"
  | "approval_required"
  | "external_action_outcome_unknown"
  | "invalid_transition"
  | "invalid_request";

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";
  constructor(readonly code: ApplicationErrorCode, message: string = code) { super(message); }
}
