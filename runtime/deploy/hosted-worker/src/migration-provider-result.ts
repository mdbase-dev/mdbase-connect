/** Fixed CBOR mirrors of Connect/legacy-provider migration route bodies for
 * native settlement (`hd_migration_provider_result`). Strict shape checks only:
 * native binds the result to the run and the exact pending action, and is the
 * only place a Driver outcome is formed. Nothing here is signed or authority. */
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const MAX_IDS = 1000;
/** Native input bound (`provider::MAX_INPUT`). */
export const MAX_PROVIDER_INPUT = 20 * 1024;

export type MigrationProviderResult =
  /** Operator `mdbase-hosted-backup-admin acquire` → `result.hold_id`. */
  | { kind: "backup"; hold_id: string }
  /** `GET /internal/v1/next/migration/accounts/:owner`. */
  | { kind: "account"; body: unknown }
  /** `POST /internal/v1/next/migration/collections/:id/fence`. */
  | { kind: "fence"; body: unknown }
  /** `GET /internal/v1/next/migration/collections/:id/source`. */
  | { kind: "drain"; body: unknown }
  /** Provider `GET /internal/v1/collections/:id/replicas`. */
  | { kind: "replicas"; body: unknown }
  /** Provider `POST …/legacy-migration/revoke-replicas`. */
  | { kind: "revoked"; body: unknown }
  /** `POST /internal/v1/next/migration/collections/:id/cutover`. */
  | { kind: "cutover"; body: unknown };

/** Driver action kind (native `codec::action`) each result settles. */
export const PROVIDER_RESULT_KIND = {
  backup: 0, account: 10, fence: 11, drain: 12, replicas: 13, revoked: 14, cutover: 19,
} as const satisfies Record<MigrationProviderResult["kind"], number>;

class Refused extends Error { constructor() { super("migration_provider_result_invalid"); } }
const refuse = (): never => { throw new Refused(); };

function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return refuse();
  const own = Object.keys(v);
  if (own.length !== keys.length || !keys.every(k => Object.hasOwn(v, k))) return refuse();
  return v as Record<string, unknown>;
}
function uuid(v: unknown): Uint8Array {
  if (typeof v !== "string" || !UUID.test(v) || v === NIL) return refuse();
  return Uint8Array.from(v.replaceAll("-", "").match(/../g)!, h => Number.parseInt(h, 16));
}
/** Sorted canonical ids; duplicates refuse here and again natively. */
function ids(v: unknown): Uint8Array[] {
  if (!Array.isArray(v) || v.length > MAX_IDS) return refuse();
  const sorted = v.map(id => { uuid(id); return id as string; }).sort();
  if (sorted.some((id, i) => i > 0 && id === sorted[i - 1])) return refuse();
  return sorted.map(uuid);
}
function bool(v: unknown): boolean { return typeof v === "boolean" ? v : refuse(); }
function count(v: unknown): number { return Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : refuse(); }
function text(v: unknown): string { return typeof v === "string" ? v : refuse(); }
function nullable<T>(v: unknown, f: (v: unknown) => T): T | null { return v === null ? null : f(v); }

/** Encode one result body; throws `migration_provider_result_invalid`. */
export function migrationProviderInput(result: MigrationProviderResult): Uint8Array {
  let fields: CborValue[];
  switch (result.kind) {
    case "backup": fields = [0, uuid(result.hold_id)]; break;
    case "account": {
      const b = object(result.body, ["account_id", "backend", "cohort", "released", "started", "terminal_excluded",
        "paused", "hosted_collections", "unsettled_collections", "cut_over_collections"]);
      fields = [1, uuid(b.account_id), text(b.backend), nullable(b.cohort, text), bool(b.released), bool(b.started),
        bool(b.terminal_excluded), bool(b.paused), ids(b.hosted_collections), ids(b.unsettled_collections),
        ids(b.cut_over_collections)];
      break;
    }
    case "fence": {
      const b = object(result.body, ["collection_id", "state", "migration_id", "started_at", "retain_until", "restored"]);
      fields = [2, uuid(b.collection_id), text(b.state), uuid(b.migration_id), text(b.started_at),
        nullable(b.retain_until, text), ids(b.restored)];
      break;
    }
    case "drain": {
      const b = object(result.body, ["collection_id", "state", "migration_id", "head", "started_at", "retain_until",
        "in_flight", "unresolved", "applied_unreceipted"]);
      fields = [3, uuid(b.collection_id), text(b.state), nullable(b.migration_id, uuid), count(b.head),
        nullable(b.started_at, text), nullable(b.retain_until, text), count(b.in_flight), count(b.unresolved),
        count(b.applied_unreceipted)];
      break;
    }
    case "replicas": {
      const b = object(result.body, ["replicas"]);
      if (!Array.isArray(b.replicas)) return refuse();
      fields = [4, ids(b.replicas.map(r => object(r, ["id", "head", "acknowledged_sequence", "last_seen_at", "token_expires_at"]).id))];
      break;
    }
    case "revoked": fields = [5, ids(object(result.body, ["revoked"]).revoked)]; break;
    case "cutover": {
      const b = object(result.body, ["collection_id", "account_id"]);
      fields = [6, uuid(b.collection_id), uuid(b.account_id)];
      break;
    }
    default: return refuse();
  }
  const input = encode(fields);
  if (input.length > MAX_PROVIDER_INPUT) return refuse();
  return input;
}
