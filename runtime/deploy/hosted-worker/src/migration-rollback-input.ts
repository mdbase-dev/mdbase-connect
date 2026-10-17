/** Fixed full ORIGINAL receipt DATA and native request-scope projection.
 * Shape only; the native saved action/context and settlement digest bind it.
 * Never turns active/restored/Ok into authority. */
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.ts";

export const MAX_ROLLBACK_INPUT = 40 * 1024;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const refuse = (): never => { throw new Error("migration_rollback_input_invalid"); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) return refuse();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  return typeof value === "string" && UUID.test(value) && value !== NIL ? value : refuse();
}
function bytes(value: unknown): Uint8Array {
  return Uint8Array.from(uuid(value).replaceAll("-", "").match(/../g)!, h => Number.parseInt(h, 16));
}
function count(value: unknown, positive = false): number {
  return Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0) ? value as number : refuse();
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) return refuse();
  const values = value.map(uuid).sort();
  if (values.some((v, i) => i > 0 && v === values[i - 1])) return refuse();
  return values;
}

export interface RollbackScope {
  providerMigrationId: string; fixedHead: number; driverId: string; actionId: string;
  replicaIds: string[]; authorityEpoch: number | null; original: boolean;
}
/** Native output DATA; an IO caller still needs its exact opaque pending guard. */
export function decodeRollbackScope(value: CborValue): RollbackScope {
  if (!Array.isArray(value) || value.length !== 7 || typeof value[6] !== "boolean") return refuse();
  const fromBytes = (v: CborValue): string => {
    if (!(v instanceof Uint8Array) || v.length !== 16) return refuse();
    const h = Array.from(v, n => n.toString(16).padStart(2, "0")).join("");
    return uuid(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`);
  };
  return { providerMigrationId: fromBytes(value[0]), fixedHead: count(value[1]), driverId: fromBytes(value[2]),
    actionId: fromBytes(value[3]), replicaIds: ids(value[4]), authorityEpoch: value[5] === null ? null : count(value[5], true), original: value[6] };
}

/** Connect must echo the entire provider receipt unchanged, not refreshed. */
export function migrationRollbackInput(body: unknown): Uint8Array {
  const r = object(body, ["collection_id", "binding", "restored_ids", "recorded_at"]);
  const b = object(r.binding, ["owner_account_id", "provider_migration_id", "authority_epoch", "fixed_head", "driver_id", "action_id", "replica_ids"]);
  const requested = ids(b.replica_ids), restored = ids(r.restored_ids);
  if (restored.some(id => !requested.includes(id)) || typeof r.recorded_at !== "string" || r.recorded_at.length < 20 || r.recorded_at.length > 64 || !/^[\x21-\x7e]+$/.test(r.recorded_at)) return refuse();
  const input = encode([bytes(r.collection_id), bytes(b.owner_account_id), bytes(b.provider_migration_id), count(b.authority_epoch, true), count(b.fixed_head), bytes(b.driver_id), bytes(b.action_id), requested.map(bytes), restored.map(bytes), r.recorded_at]);
  if (input.length > MAX_ROLLBACK_INPUT) return refuse();
  return input;
}
