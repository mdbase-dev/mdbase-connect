/**
 * The six-digit device-approval code: display, parsing and comparison only.
 *
 * **The code is computed by the runtime, never here.** The original formula,
 * `H("mdbase/v1/sas", collection ‖ recipient ‖ sign_pk ‖ kem_pk) mod 10^6`, can be
 * ground by the control plane in about 10^6 tries. The fix
 * is a commit-then-reveal SAS (SAS-MCA):
 * - the new device commits to `r2` in its `device-enrol`;
 * - the approver sends `r1` only after it sees that item;
 * - the new device reveals `r2`;
 * - both show `H("mdbase/v1/sas", collection ‖ D1 ‖ D2 ‖ keys ‖ r1 ‖ r2) mod 10^6`.
 *
 * That needs both devices' secrets and the exchange, which live in the replica.
 * So both sides get the code from the runtime: the approver from `pending_devices`,
 * the new device from its status. Keeping a local formula here would only invite
 * using the grindable one.
 */

/** Display form: `"042 917"`. */
export function formatSas(sas: string): string {
  if (!/^\d{6}$/.test(sas)) throw new Error("a code is six digits");
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

/** Normalise what a user typed (`"042-917"`, `" 042917 "`) to six digits, or `null`. */
export function parseSas(input: string): string | null {
  const d = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(d) ? d : null;
}

/** Compare two codes without an early exit on the first differing digit. */
export function sasEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
