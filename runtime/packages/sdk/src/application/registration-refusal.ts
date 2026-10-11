/** The typed part of a CP application-registration refusal: its code and at most a
 * few JSON-pointer paths into the app's own manifest. Never the server message,
 * URLs or other text. No network, Worker or wasm imports. */
export interface RegistrationRefusal {
  readonly code: string;
  readonly paths: readonly string[];
}

/** Bytes read from a refusal body; anything larger is treated as untyped. */
export const REGISTRATION_REFUSAL_MAX_BYTES = 8192;
const MAX_PATHS = 5;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const POINTER = /^(?:\/[A-Za-z0-9_-]{1,64}){1,6}$/;
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** `{error: {code, details: {issues: [{path}]}}}` (CP `apiError`), or an already
 * sanitized refusal (object, or the `MdbaseError.details` map); null for anything
 * else. Never throws. */
export function registrationRefusal(value: unknown): RegistrationRefusal | null {
  try {
    if (value instanceof Map) value = { code: value.get("code"), paths: value.get("paths") };
    const o = obj(value), error = obj(o?.error) ?? o;
    const code = error?.code;
    if (typeof code !== "string" || !CODE.test(code)) return null;
    const issues = obj(error!.details)?.issues;
    const candidates = Array.isArray(error!.paths) ? error!.paths : Array.isArray(issues) ? issues.slice(0, 64).map((issue) => obj(issue)?.path) : [];
    const paths: string[] = [];
    for (const path of candidates.slice(0, 64)) {
      if (typeof path === "string" && POINTER.test(path) && !paths.includes(path)) paths.push(path);
      if (paths.length === MAX_PATHS) break;
    }
    return Object.freeze({ code, paths: Object.freeze(paths) });
  } catch {
    return null; /* hostile getters never replace the refusal */
  }
}

/** Plain copy for app developers, e.g. "This app's registration was rejected
 * (invalid manifest: /homepage, /icon)." */
export function registrationRefusalMessage(refusal: RegistrationRefusal | null): string {
  if (!refusal) return "This app's registration was rejected by mdbase.";
  const label = refusal.code === "invalid_application_manifest" ? "invalid manifest" : refusal.code.replaceAll("_", " ");
  return `This app's registration was rejected (${label}${refusal.paths.length ? `: ${refusal.paths.join(", ")}` : ""}).`;
}
