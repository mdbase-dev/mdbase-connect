/** The executor's client of Connect's migration-token routes. Transport only:
 * every body that settles an action is checked and bound natively; this client
 * returns the status, the error code and the parsed body and decides nothing.
 * HTTPS only, no redirects, bounded replies, abortable. */

import type { RollbackScope } from "./migration-rollback-input.ts";
import { localBuild, localOrigin } from "./local-origin.ts";

const MAX_REPLY_BYTES = 16 * 1024;
/** Two full 1000-UUID vectors plus fixed original receipt fields. */
const MAX_RECEIPT_REPLY_BYTES = 80 * 1024;
const TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export interface ConnectReply {
  status: number;
  /** Connect's `error` code on a refusal, when it sent one. */
  code: string | null;
  body: unknown;
}

/** The current claim and provider run every claim-bound route requires. */
export interface ClaimBinding { owner_account: string; started_us: string; migration_id: string }

export interface CutoverFacts { s_final: number; cutover_seq: number; barrier_f: number; final_digest: string }

export interface MigrationConnect {
  account(owner: string, signal: AbortSignal): Promise<ConnectReply>;
  fence(collection: string, signal: AbortSignal): Promise<ConnectReply>;
  source(collection: string, signal: AbortSignal): Promise<ConnectReply>;
  replicas(collection: string, binding: ClaimBinding, signal: AbortSignal): Promise<ConnectReply>;
  revoke(collection: string, binding: ClaimBinding, ids: string[], signal: AbortSignal): Promise<ConnectReply>;
  membersPolicy(collection: string, binding: ClaimBinding, signal: AbortSignal): Promise<ConnectReply>;
  cutoverPolicy(collection: string, binding: ClaimBinding, revoked: string[], baseSeq: number, signal: AbortSignal): Promise<ConnectReply>;
  cutover(collection: string, facts: CutoverFacts, signal: AbortSignal): Promise<ConnectReply>;
  rollback(collection: string, binding: ClaimBinding, scope: RollbackScope, signal: AbortSignal): Promise<ConnectReply>;
  rollbackReceipt(collection: string, binding: ClaimBinding, scope: RollbackScope, signal: AbortSignal): Promise<ConnectReply>;
}

export function connectClient(config: { url: string; token: string; environment?: string }, fetchImpl: typeof fetch = fetch): MigrationConnect {
  const url = new URL(config.url);
  if ((localBuild() ? !localOrigin(config.url, config.environment) : config.environment === "local" || url.protocol !== "https:")
      || url.username || url.password) throw new Error("migration_connect_unconfigured");
  if (config.token.length < 32) throw new Error("migration_connect_unconfigured");
  const base = url.toString().replace(/\/+$/, "");
  const call = async (path: string, init: { method: "GET" | "POST"; body?: unknown }, signal: AbortSignal, maxReplyBytes = MAX_REPLY_BYTES): Promise<ConnectReply> => {
    const response = await fetchImpl(`${base}${path}`, {
      method: init.method, redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { authorization: `Bearer ${config.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxReplyBytes) { await reader.cancel(); throw new Error("migration_connect_reply_over_bound"); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    let body: unknown = null;
    try { body = total ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) : null; } catch { body = null; }
    const code = response.ok || !body || typeof body !== "object" ? null
      : typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error
      : typeof (body as { error?: { code?: unknown } }).error?.code === "string" ? (body as { error: { code: string } }).error.code
      : typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : null;
    return { status: response.status, code, body };
  };
  const id = (v: string): string => { if (!UUID.test(v)) throw new Error("migration_connect_invalid_id"); return v; };
  const collection = (c: string) => `/internal/v1/next/migration/collections/${id(c)}`;
  const rollbackBody = (b: ClaimBinding, s: RollbackScope) => ({
    ...b, migration_id: id(s.providerMigrationId), driver_id: id(s.driverId), action_id: id(s.actionId),
    fixed_head: s.fixedHead, replica_ids: s.replicaIds.map(id),
    ...(s.authorityEpoch === null ? {} : { authority_epoch: s.authorityEpoch }),
  });
  return {
    account: (owner, signal) => call(`/internal/v1/next/migration/accounts/${id(owner)}`, { method: "GET" }, signal),
    fence: (c, signal) => call(`${collection(c)}/fence`, { method: "POST", body: {} }, signal),
    source: (c, signal) => call(`${collection(c)}/source`, { method: "GET" }, signal),
    replicas: (c, b, signal) => call(`${collection(c)}/replicas`, { method: "POST", body: b }, signal),
    revoke: (c, b, ids, signal) => call(`${collection(c)}/replicas/revoke`, { method: "POST", body: { ...b, replica_ids: [...ids].sort() } }, signal),
    membersPolicy: (c, b, signal) => call(`${collection(c)}/members-policy`, { method: "POST", body: b }, signal),
    cutoverPolicy: (c, b, revoked, baseSeq, signal) => call(`${collection(c)}/cutover-policy`,
      { method: "POST", body: { ...b, revoked: [...revoked].sort(), base_seq: baseSeq } }, signal),
    cutover: (c, facts, signal) => call(`${collection(c)}/cutover`, { method: "POST", body: facts }, signal),
    rollback: (c, b, scope, signal) => call(`${collection(c)}/rollback`, { method: "POST", body: rollbackBody(b, scope) }, signal, MAX_RECEIPT_REPLY_BYTES),
    rollbackReceipt: (c, b, scope, signal) => call(`${collection(c)}/rollback-receipt`, { method: "POST", body: rollbackBody(b, scope) }, signal, MAX_RECEIPT_REPLY_BYTES),
  };
}
