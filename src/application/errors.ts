export type ApplicationErrorCode =
  | "campaign_not_found"
  | "campaign_conflict"
  | "approval_required"
  | "invalid_transition"
  | "invalid_request";

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";
  constructor(readonly code: ApplicationErrorCode) { super(code); }
}
