import { SyncError } from "./sync-error.js";

export class AuthorityAdoptionError extends SyncError {
  constructor(
    code: string,
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(code, message);
    this.name = "AuthorityAdoptionError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The source must stay fenced until exchange/complete establishes the outcome. */
export class AuthorityAdoptionOutcomeUnknownError extends AuthorityAdoptionError {
  readonly sourceMustRemainFenced = true;

  constructor(message: string, options?: ErrorOptions) {
    super("authority_adoption_outcome_unknown", message, undefined, options);
    this.name = "AuthorityAdoptionOutcomeUnknownError";
  }
}
