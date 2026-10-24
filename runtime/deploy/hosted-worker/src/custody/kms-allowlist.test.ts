import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  KMS_ALLOWLIST_SCHEMA, KmsAllowlist, MAX_KMS_COLLECTIONS, canonicalKmsAllowlist, cumulativeKmsAllowlist,
  deploymentKmsAllowlist, kmsAllowlistDigest, type BundledKmsAllowlist,
} from "./kms-allowlist.ts";
import { HostedAwsKms } from "./aws-kms.ts";

// Deterministic, valid, non-nil v4-shaped UUIDs.
function ids(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, i) => {
    const h = (i + offset + 1).toString(16).padStart(12, "0");
    return `${h.slice(0, 8)}-abcd-4000-8000-${h}`;
  });
}
const sha = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");
const bundle = (list: string[]): BundledKmsAllowlist => {
  const text = canonicalKmsAllowlist(list);
  return { schema: KMS_ALLOWLIST_SCHEMA, sha256: sha(text), text };
};
const code = (c: string) => (e: Error) => e.message === c;

test("canonical text: sorted, unique, LF-terminated lowercase UUIDs; digest is plain SHA-256", () => {
  const list = ids(3).reverse();
  const text = canonicalKmsAllowlist([...list, list[0]]);
  assert.equal(text, [...list].sort().map(x => x + "\n").join(""));
  assert.equal(kmsAllowlistDigest(text), sha(text));
  const a = KmsAllowlist.parse(text, sha(text));
  assert.equal(a.size, 3);
  for (const id of list) assert.ok(a.has(id));
  assert.equal(KmsAllowlist.parse("").size, 0, "empty is the deny-all allowlist");
  for (const bad of [text.trimEnd(), text.toUpperCase(), text.replace("\n", "\r\n"), [...list].map(x => x + "\n").join(""),
    text + text.slice(0, 37), "00000000-0000-0000-0000-000000000000\n", "not-a-uuid-not-a-uuid-not-a-uuid-xxx\n"]) {
    assert.throws(() => KmsAllowlist.parse(bad), code("kms_allowlist_invalid"), JSON.stringify(bad.slice(0, 40)));
  }
});

test("allowlist digest mismatch refuses", () => {
  const text = canonicalKmsAllowlist(ids(5));
  assert.throws(() => KmsAllowlist.parse(text, sha(text + "x")), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => KmsAllowlist.parse(text, sha(text).toUpperCase()), code("kms_allowlist_digest_mismatch"));
});

test("1,000+ entries are accepted, up to the 100,000 cap; members found, non-members refused", () => {
  for (const n of [1_000, 1_200, MAX_KMS_COLLECTIONS]) {
    const list = ids(n);
    const a = KmsAllowlist.parse(canonicalKmsAllowlist(list));
    assert.equal(a.size, n);
    for (const id of [list[0], list[n >> 1], list[n - 1]]) assert.ok(a.has(id));
    for (const id of ids(3, n)) assert.equal(a.has(id), false);
    assert.equal(a.has(list[0].toUpperCase()), false);
    assert.equal(a.has(""), false);
  }
  assert.throws(() => canonicalKmsAllowlist(ids(MAX_KMS_COLLECTIONS + 1)), code("kms_allowlist_invalid"));
  assert.throws(() => KmsAllowlist.fromList(ids(MAX_KMS_COLLECTIONS + 1)), code("kms_allowlist_invalid"));
});

test("HostedAwsKms serves a 1,000+ entry allowlist and refuses non-members before any KMS call", async () => {
  const list = ids(1_500);
  let calls = 0;
  const kms = new HostedAwsKms({ keyArn: "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333", region: "us-east-1",
    environment: "staging", collections: KmsAllowlist.fromList(list) }, () => null, async () => { calls++; throw new Error("unexpected"); });
  const outsider = ids(1, 1_500)[0];
  await assert.rejects(kms.wrapDeviceKeys({ collection: outsider, device: list[0], secret: new Uint8Array(96) }, AbortSignal.timeout(1000)),
    code("kms_collection_not_allowed"));
  assert.equal(calls, 0);
  // A member reaches the credential check (no credentials here), not the allowlist refusal.
  await assert.rejects(kms.wrapDeviceKeys({ collection: list[999], device: list[0], secret: new Uint8Array(96) }, AbortSignal.timeout(1000)),
    code("kms_credentials_unavailable"));
  // A plain list over the cap is an invalid configuration.
  assert.throws(() => new HostedAwsKms({ keyArn: "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333",
    region: "us-east-1", environment: "staging", collections: ids(MAX_KMS_COLLECTIONS + 1) }, () => null), code("kms_invalid_config"));
});

test("cumulative: a shrinking allowlist is refused without the explicit retire list", () => {
  const prev = KmsAllowlist.fromList(ids(1_000));
  const grown = KmsAllowlist.fromList(ids(1_200));
  assert.deepEqual(cumulativeKmsAllowlist(prev, grown, null), { added: 200, retired: 0 });
  assert.deepEqual(cumulativeKmsAllowlist(prev, prev, null), { added: 0, retired: 0 });
  // Dropping one previously served collection, even while adding others.
  const dropped = KmsAllowlist.fromList([...ids(999, 1), ...ids(50, 5_000)]);
  assert.throws(() => cumulativeKmsAllowlist(prev, dropped, null), code("kms_allowlist_shrinks"));
  assert.throws(() => cumulativeKmsAllowlist(prev, KmsAllowlist.parse(""), null), code("kms_allowlist_shrinks"));
  // The same change with the dropped collection named in the retire list.
  const retire = KmsAllowlist.fromList(ids(1));
  assert.deepEqual(cumulativeKmsAllowlist(prev, dropped, retire), { added: 50, retired: 1 });
  // A retire list must name only served collections that the change stops serving.
  assert.throws(() => cumulativeKmsAllowlist(prev, dropped, KmsAllowlist.fromList(ids(1, 9_000))), code("kms_allowlist_retire_not_served"));
  assert.throws(() => cumulativeKmsAllowlist(prev, grown, retire), code("kms_allowlist_retire_still_served"));
});

test("deployment allowlist: the bundled module wins, pinned by the declared digest; the secret must agree", () => {
  const list = ids(1_000);
  const b = bundle(list);
  const fromBundle = deploymentKmsAllowlist(b, b.sha256, undefined);
  assert.equal(fromBundle.size, 1_000);
  assert.equal(deploymentKmsAllowlist(b, b.sha256, undefined), fromBundle, "validated once per bundle");
  // Digest pinned in the deploy config must equal the bundled module's.
  assert.throws(() => deploymentKmsAllowlist(b, undefined, undefined), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => deploymentKmsAllowlist(b, sha("other"), undefined), code("kms_allowlist_digest_mismatch"));
  // A module whose text does not match its own digest refuses.
  const tampered = { ...b, text: canonicalKmsAllowlist(ids(1_000, 1)) };
  assert.throws(() => deploymentKmsAllowlist(tampered, b.sha256, undefined), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => deploymentKmsAllowlist({ ...b, schema: "other" } as unknown as BundledKmsAllowlist, b.sha256, undefined), code("kms_allowlist_invalid"));
  // Transitional secret: the same set (any order) is accepted; any difference refuses.
  assert.equal(deploymentKmsAllowlist(b, b.sha256, [...list].reverse().join(",")).size, 1_000);
  assert.throws(() => deploymentKmsAllowlist(b, b.sha256, list.slice(1).join(",")), code("kms_allowlist_secret_disagrees"));
  assert.throws(() => deploymentKmsAllowlist(b, b.sha256, ""), code("kms_allowlist_secret_disagrees"));
  // No bundled module: the secret alone (transition); a declared digest without a module refuses.
  assert.equal(deploymentKmsAllowlist(null, undefined, list.slice(0, 3).join(",")).size, 3);
  assert.equal(deploymentKmsAllowlist(null, undefined, undefined).size, 0);
  assert.throws(() => deploymentKmsAllowlist(null, b.sha256, undefined), code("kms_allowlist_digest_mismatch"));
});
