import { labCustodySubCause, type LabCustodySubCause } from "./custody/hosted-custody.ts";

/** Finite ready-stage diagnostic DATA; separate raw diagnostics are explicitly LAB-only. */
export const READY_STAGES = [
  "background_guard", "physical_collection_guard", "collection_guard", "service_collection_persist", "alarm_guard",
  "open_retry_read", "open_retry_schedule", "custody_open_sealer", "mode_device_persist", "engine_construct", "engine_config",
  "engine_cpp_open", "engine_open", "engine_noise_key", "custody_zeroize", "pin_digest", "pin_marker_read",
  "pin_mismatch", "live_admission", "sync", "pin_parked_guard", "timing_snapshot", "engine_reset",
  "open_failure_clear", "unknown",
] as const;
export type ReadyStage = typeof READY_STAGES[number];
export interface ReadyTrace { stage: ReadyStage; opening?: ReadyTrace }
export const READY_ERROR_NAMES = ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError", "other"] as const;
export const READY_ERROR_CODES = [
  "pitr_actor_closed", "hosted_alarm_inhibited", "physical_collection_mismatch", "collection_mismatch", "hosted_pin_parked",
  "custody_unavailable", "custody_aborted", "custody_invalid_record", "custody_identity_mismatch", "custody_record_changed",
  "custody_secret_invalid", "custody_collection_not_allowed", "custody_collection_gone", "custody_envelope_invalid", "custody_key_not_configured", "kms_refused", "kms_invalid_response",
  "kms_aborted", "kms_credentials_unavailable", "cpp_owned_control_not_established", "hosted_engine_already_opened",
  "hosted_cache_reset", "pin_mismatch_reset", "unknown",
] as const;
const OWNED_MESSAGES: Readonly<Record<string, typeof READY_ERROR_CODES[number]>> = {
  "collection mismatch": "collection_mismatch",
  "hosted engine already opened": "hosted_engine_already_opened",
  "hosted cache reset; retry": "hosted_cache_reset",
  "hosted cache reset after pin mismatch; retry": "pin_mismatch_reset",
};
export interface ReadyDiagnostic {
  stage: ReadyStage;
  error_name: typeof READY_ERROR_NAMES[number];
  error_class: "error" | "type_error" | "range_error" | "abort_error" | "timeout_error" | "other";
  error_code: typeof READY_ERROR_CODES[number];
}
/** JSON reply only, never console output or persistence; never enabled outside literal LAB. */
export function labRawError(lab: string | undefined, error: unknown): { raw_error?: { message: string | null; stack: string | null; sub_cause?: LabCustodySubCause } } {
  if (lab !== "1") return {};
  const text = (key: "message" | "stack"): string | null => {
    try {
      const value = error !== null && typeof error === "object" ? Reflect.get(error, key) : undefined;
      return typeof value === "string" ? value : null;
    } catch { return null; }
  };
  const subCause = labCustodySubCause(error);
  const message = typeof error === "string" ? error : text("message");
  // The currently deployed CLI33a captures message/stack only; keep the bounded
  // call details readable there too while newer CLI builds retain structured data.
  return { raw_error: { message: subCause
    ? `${message ?? ""}; ${subCause.call}: ${subCause.name ?? "other"}: ${subCause.message ?? ""}` : message,
    stack: text("stack"), ...(subCause ? { sub_cause: subCause } : {}) } };
}

export function readyDiagnostic(stage: unknown, error: unknown): ReadyDiagnostic {
  // An exception getter must not turn the diagnostic into another exception.
  const property = (key: string): unknown => {
    try { return error !== null && typeof error === "object" ? Reflect.get(error, key) : undefined; }
    catch { return undefined; }
  };
  const name = error instanceof Error ? property("name") : undefined;
  const errorName = READY_ERROR_NAMES.find(value => value === name) ?? "other";
  const errorClass = errorName === "Error" ? "error" : errorName === "TypeError" ? "type_error"
    : errorName === "RangeError" ? "range_error" : errorName === "AbortError" ? "abort_error"
    : errorName === "TimeoutError" ? "timeout_error" : "other";
  const code = property("code"), message = error instanceof Error ? property("message") : undefined;
  const errorCode = READY_ERROR_CODES.find(value => value === code) ?? READY_ERROR_CODES.find(value => value === message)
    ?? (typeof message === "string" && Object.hasOwn(OWNED_MESSAGES, message) ? OWNED_MESSAGES[message] : "unknown");
  return { stage: READY_STAGES.find(value => value === stage) ?? "unknown", error_name: errorName,
    error_class: errorClass, error_code: errorCode };
}
