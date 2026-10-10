/**
 * Errors. Every failure is an {@link MdbaseError} with a stable {@link ErrorCode},
 * a message that says what went wrong, and `help` that says what to do.
 */

/** Stable error codes. Spec diagnostic codes (`schema_required`, `invalid_query`, ...) pass through unchanged. */
export type ErrorCode =
  | "invalid_input"
  | "invalid_json"
  | "unknown_op"
  | "wasm_incompatible"
  | "wasm_unavailable"
  | "invalid_schema"
  | "invalid_query"
  | "invalid_data_contract"
  | "invalid_implementation"
  | "invalid_type_pack"
  | "concurrent_modification"
  | "type_pack_conflict"
  | "type_pack_apply_failed"
  | (string & {});

const HELP: Partial<Record<string, string>> = {
  invalid_input: "Check the arguments against the function's documentation.",
  invalid_schema: "Fix the JSON Schema document; `details` lists each problem with its location.",
  invalid_query: "Fix the query object; `location` names the offending member.",
  invalid_data_contract: "Fix the contract file; it must be a `kind: mdbase.contract` document with a valid id, semver version and schema wrappers.",
  invalid_implementation: "The type's `implements` entry does not satisfy the contract; `details` lists the catalog issues.",
  invalid_type_pack: "Fix the pack manifest or its resources; `details` says which.",
  concurrent_modification: "The collection changed since the assessment. Call assessTypePack again and retry with the new assessment digest.",
  type_pack_conflict: "A target is user-modified. Pass `options.adopt` with its current digest to adopt it, or resolve the conflict by hand.",
  wasm_unavailable: "Call `init({ wasm })` with the bytes or URL of mdbase-core.wasm before using the helpers.",
};

/** The error every `mdbase` function throws. */
export class MdbaseError extends Error {
  /** A stable code. */
  readonly code: ErrorCode;
  /** What to do about it. */
  readonly help: string;
  /** Where: a resource path, a JSON Pointer or a query member. */
  readonly location?: string;
  /** Structured details, when there are any (issues, schema errors). */
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, help?: string, extra?: { location?: string; details?: unknown }) {
    super(message);
    this.name = "MdbaseError";
    this.code = code;
    this.help = help ?? HELP[code] ?? "";
    if (extra?.location !== undefined) this.location = extra.location;
    if (extra?.details !== undefined) this.details = extra.details;
  }

  /** @internal */
  static fromWire(e: { code: string; message: string; location?: string; details?: unknown }): MdbaseError {
    const extra: { location?: string; details?: unknown } = {};
    if (e.location !== undefined) extra.location = e.location;
    if (e.details !== undefined) extra.details = e.details;
    return new MdbaseError(e.code, e.message, undefined, extra);
  }
}
