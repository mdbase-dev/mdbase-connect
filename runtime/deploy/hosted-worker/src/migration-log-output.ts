/** Fixed CBOR mirror for the native migration log path (`hd_migration_log_*`,
 * `migration_action_ledger::log`). Native seals, sends and settles every log
 * action from the Engine's own log evidence; the host passes no input and
 * forms no Outcome. Strict shape checks only. */
import { decode } from "../../../packages/sdk/src/cbor.js";

/** Driver action kinds settled from the log (native `codec::action`). */
export const LOG_KIND = {
  appendBase: 6,
  findBase: 7,
  rebuild: 8,
  readNew: 9,
  appendCutover: 15,
  findCutover: 16,
  logHead: 18,
} as const;
const LOG_KINDS: ReadonlySet<number> = new Set(Object.values(LOG_KIND));

/** Whether `kind` is a log action native settles with `hd_migration_log_result`. */
export function isLogKind(kind: number): boolean {
  return LOG_KINDS.has(kind);
}

/** The base native sent (or resent) for the pending `AppendBase`: DATA, not a
 * settlement; only `hd_migration_log_result` settles. */
export interface LogAppendSent { item: string; seq: number }

function refuse(): never {
  throw new Error("migration_log_output_invalid");
}

/** Decode native's `[item hash, seq]`. */
export function decodeLogAppendSent(output: Uint8Array): LogAppendSent {
  const v = decode(output);
  if (!Array.isArray(v) || v.length !== 2) return refuse();
  const [item, seq] = v;
  if (!(item instanceof Uint8Array) || item.length !== 32) return refuse();
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return refuse();
  return { item: Array.from(item, b => b.toString(16).padStart(2, "0")).join(""), seq };
}
