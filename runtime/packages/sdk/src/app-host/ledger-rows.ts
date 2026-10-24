/** Validate a write-ledger entry read back from the replica database. */
import type { WriteLedgerEntry } from "../write-ledger.js";
import type { Problem } from "../wire.js";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export function ledgerEntry(value: unknown): WriteLedgerEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.mutationId !== "string" || !uuid.test(v.mutationId)) return null;
  if (!Array.isArray(v.records) || !v.records.every((r) => typeof r === "string")) return null;
  if (typeof v.createdAt !== "number" || (v.state !== "pending" && v.state !== "rejected")) return null;
  const p = v.problem as Problem | undefined;
  if (p !== undefined && (!p || typeof p.code !== "string" || typeof p.message !== "string" || typeof p.recovery !== "string")) return null;
  return {
    mutationId: v.mutationId,
    records: [...v.records as string[]],
    createdAt: v.createdAt,
    state: v.state,
    ...(p ? { problem: { code: p.code, recovery: p.recovery, message: p.message, ...(p.reason ? { reason: p.reason } : {}) } } : {}),
  };
}
