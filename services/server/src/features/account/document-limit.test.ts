import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { effectiveEntitlement } from "../../entitlements.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** A `pub const NAME: u64 = <literal>;` from the runtime's Rust source. */
function rustConstant(path: string, name: string): number {
  const source = readFileSync(new URL(`../../../../../runtime/crates/${path}`, import.meta.url), "utf8");
  const match = new RegExp(`pub const ${name}: u64 = ([0-9_]+);`, "u").exec(source);
  if (!match) throw new Error(`${name} not found in ${path}`);
  return Number(match[1]!.replaceAll("_", ""));
}

it("reports the native replica's record cap as a next account's document limit", async () => {
  const cap = rustConstant("wire/src/unindexed_markdown.rs", "RECORD_SOURCE_CAP_BYTES");
  expect(rustConstant("core/src/intent.rs", "RECORD_SOURCE_CAP_BYTES")).toBe(cap);
  const db = await createDatabase("memory"); cleanup.push(() => db.end());
  const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" }); cleanup.push(() => app.close());
  const email = `${randomUUID()}@example.test`;
  const response = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Document owner", email } });
  const raw = response.headers["set-cookie"]!;
  const cookie = (Array.isArray(raw) ? raw[0]! : raw).split(";")[0]!;
  const owner = (await db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [email])).rows[0]!.id;
  const documentLimit = async () =>
    (await app.inject({ url: "/v1/me", headers: { cookie } })).json().subscription.limits.max_document_bytes;
  // The legacy hosted provider enforces the entitlement's own limit.
  const entitlement = await effectiveEntitlement(db, owner);
  expect(entitlement!.maxDocumentBytes).not.toBe(cap);
  expect(await documentLimit()).toBe(entitlement!.maxDocumentBytes);
  await db.query("UPDATE users SET account_backend='next' WHERE id=$1", [owner]);
  expect(await documentLimit()).toBe(cap);
});
