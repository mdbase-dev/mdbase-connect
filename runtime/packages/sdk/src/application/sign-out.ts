/** UX-011: shared sign-out guard for the entry and the testing fixtures. */
import { mdbaseError } from "../errors.js";

/** Unconfirmed writes on the open collection: the larger of the write ledger's
 * pending entries and the replica's status (0 when none is open). */
export function pendingWrites(connection: { readonly records: { readonly status: { readonly pending: number }; readonly ledger?: { getSnapshot(): { readonly pending: readonly unknown[] } } } } | null | undefined): number {
  let status = 0, ledger = 0;
  try { const pending = connection?.records.status.pending; status = typeof pending === "number" && pending > 0 ? pending : 0; } catch { status = 0; }
  try { ledger = connection?.records.ledger?.getSnapshot().pending.length ?? 0; } catch { ledger = 0; }
  return Math.max(status, ledger);
}
/** The typed refusal while writes are unconfirmed; `{discard: true}` overrides
 * it. `details` is the number of unconfirmed writes. */
export function signOutPendingWritesError(pending = 0) {
  const what = pending === 1 ? "1 change hasn't" : pending > 1 ? `${pending} changes haven't` : "Some changes haven't";
  return mdbaseError("conflict", `${what} reached mdbase yet. Wait for them to finish, or sign out anyway and lose them on this device.`, { reason: "sign_out_pending_writes", details: pending });
}
