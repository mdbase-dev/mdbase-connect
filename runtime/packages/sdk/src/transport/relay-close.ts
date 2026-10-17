/** Bounded transport observations only: never admission, authority or raw close text. */
const classes = {
  1000: "normal", 1001: "going_away", 1002: "protocol_error", 1003: "unsupported_data",
  1005: "no_status", 1006: "abnormal", 1007: "invalid_payload", 1008: "policy_violation",
  1009: "message_too_big", 1010: "extension_required", 1011: "internal_error",
  1012: "service_restart", 1013: "try_again_later", 1014: "bad_gateway", 1015: "tls_failure",
  4000: "pipe_closed", 4401: "unauthenticated", 4403: "grant_inactive",
  4404: "connector_offline", 4429: "connector_busy",
} as const;

export interface RelayCloseDiagnostic {
  readonly closeCode: number | null;
  readonly closeClass: (typeof classes)[keyof typeof classes] | "other" | "unknown";
}

export function relayCloseDiagnostic(code: unknown): RelayCloseDiagnostic {
  const closeCode = typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : null;
  return Object.freeze({ closeCode, closeClass: closeCode === null ? "unknown" : classes[closeCode as keyof typeof classes] ?? "other" });
}

/** Reconstruct only our bounded fields; arbitrary map values never reach snapshots. */
export function relayCloseFromDetails(details: unknown): RelayCloseDiagnostic | undefined {
  try {
    if (details instanceof Map && details.has("relayCloseCode")) return relayCloseDiagnostic(details.get("relayCloseCode"));
  } catch { /* Untrusted adapter details are not diagnostics. */ }
  return undefined;
}
