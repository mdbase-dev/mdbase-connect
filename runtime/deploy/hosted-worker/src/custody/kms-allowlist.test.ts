import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  KMS_ALLOWLIST_SCHEMA, KMS_ALLOW_ALL_TEXT, KmsAllowlist, MAX_KMS_COLLECTIONS, canonicalKmsAllowlist, cumulativeKmsAllowlist,
  deploymentKmsAllowlist, kmsAllowlistDigest, type BundledKmsAllowlist, type KmsAllowAllRole, type KmsDeployment,
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

test("staging/production require a digest-pinned module at 1000 and 10000 entries; inherited secrets are inert", () => {
  for (const environment of ["staging", "production"]) for (const count of [1_000, 10_000]) {
    const list = ids(count), b = bundle(list);
    for (const obsolete of [undefined, "invalid obsolete secret", ids(1, count).join(",")]) {
      const value = deploymentKmsAllowlist(b, b.sha256, obsolete, environment);
      assert.equal(value.size, count); assert.ok(value.has(list[count - 1]));
      assert.equal(value.has(ids(1, count)[0]), false);
    }
    for (const obsolete of [undefined, list.join(",")]) {
      assert.throws(() => deploymentKmsAllowlist(null, b.sha256, obsolete, environment), code("kms_allowlist_bundle_required"));
      assert.throws(() => deploymentKmsAllowlist(null, undefined, obsolete, environment), code("kms_allowlist_bundle_required"));
    }
    assert.throws(() => deploymentKmsAllowlist(b, undefined, list.join(","), environment), code("kms_allowlist_digest_mismatch"));
    assert.throws(() => deploymentKmsAllowlist(b, sha("wrong"), undefined, environment), code("kms_allowlist_digest_mismatch"));
  }
  assert.throws(() => deploymentKmsAllowlist(null, undefined, undefined, "dev"), code("kms_invalid_config"));
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
  const fromBundle = deploymentKmsAllowlist(b, b.sha256, undefined, "lab");
  assert.equal(fromBundle.size, 1_000);
  assert.equal(deploymentKmsAllowlist(b, b.sha256, undefined, "lab"), fromBundle, "validated once per bundle");
  // Digest pinned in the deploy config must equal the bundled module's.
  assert.throws(() => deploymentKmsAllowlist(b, undefined, undefined, "lab"), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => deploymentKmsAllowlist(b, sha("other"), undefined, "lab"), code("kms_allowlist_digest_mismatch"));
  // A module whose text does not match its own digest refuses.
  const tampered = { ...b, text: canonicalKmsAllowlist(ids(1_000, 1)) };
  assert.throws(() => deploymentKmsAllowlist(tampered, b.sha256, undefined, "lab"), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => deploymentKmsAllowlist({ ...b, schema: "other" } as unknown as BundledKmsAllowlist, b.sha256, undefined, "lab"), code("kms_allowlist_invalid"));
  // Transitional secret: the same set (any order) is accepted; any difference refuses.
  assert.equal(deploymentKmsAllowlist(b, b.sha256, [...list].reverse().join(","), "lab").size, 1_000);
  assert.throws(() => deploymentKmsAllowlist(b, b.sha256, list.slice(1).join(","), "lab"), code("kms_allowlist_secret_disagrees"));
  assert.throws(() => deploymentKmsAllowlist(b, b.sha256, "", "lab"), code("kms_allowlist_secret_disagrees"));
  // No bundled module: the secret alone (transition); a declared digest without a module refuses.
  assert.equal(deploymentKmsAllowlist(null, undefined, list.slice(0, 3).join(","), "lab").size, 3);
  assert.equal(deploymentKmsAllowlist(null, undefined, undefined, "lab").size, 0);
  assert.throws(() => deploymentKmsAllowlist(null, b.sha256, undefined, "lab"), code("kms_allowlist_digest_mismatch"));
});

// ---- Allow-all (CP hosted/escrow, staging/production only) ----
const ALL_SHA = sha(KMS_ALLOW_ALL_TEXT);
const allBundle = (role: KmsAllowAllRole): BundledKmsAllowlist => ({ schema: KMS_ALLOWLIST_SCHEMA, sha256: ALL_SHA, text: KMS_ALLOW_ALL_TEXT, role });
const cp = (role: KmsAllowAllRole): KmsDeployment => ({ role, serviceKind: role, migration: false });

test("allow-all: exactly \"*\\n\", digest-pinned like a list, admits every valid collection ID", () => {
  const all = KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT, ALL_SHA);
  assert.equal(all.all, true); assert.equal(all.size, 0); assert.deepEqual([...all.ids()], []);
  for (const id of ids(3, 77_000)) assert.ok(all.has(id));
  for (const bad of ["", "00000000-0000-0000-0000-000000000000", ids(1)[0].toUpperCase(), "*", ids(1)[0] + "x"]) assert.equal(all.has(bad), false);
  assert.equal(KmsAllowlist.parse("").all, false);
  assert.equal(KmsAllowlist.parse(canonicalKmsAllowlist(ids(2))).all, false);
  for (const near of ["*", "* \n", "*\r\n", "*\n*\n", "**\n", " *\n", "*\n" + ids(1)[0] + "\n", ids(1)[0] + "\n*\n", "ALL\n"]) {
    assert.throws(() => KmsAllowlist.parse(near), code("kms_allowlist_invalid"), JSON.stringify(near));
  }
  assert.throws(() => KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT, sha("")), code("kms_allowlist_digest_mismatch"));
  assert.throws(() => KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT, ALL_SHA.toUpperCase()), code("kms_allowlist_digest_mismatch"));
  // The transitional comma-separated secret can never express allow-all.
  assert.throws(() => KmsAllowlist.fromList(["*"]), code("kms_allowlist_invalid"));
  assert.throws(() => KmsAllowlist.fromList(["*", ids(1)[0]]), code("kms_allowlist_invalid"));
});

test("allow-all cumulative transitions: list -> all is growth; all -> list always refuses", () => {
  const all = KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT);
  const empty = KmsAllowlist.parse("");
  const list = KmsAllowlist.fromList(ids(195));
  assert.deepEqual(cumulativeKmsAllowlist(empty, all, null), { added: "all", retired: 0 });
  assert.deepEqual(cumulativeKmsAllowlist(list, all, null), { added: "all", retired: 0 });
  assert.deepEqual(cumulativeKmsAllowlist(all, all, null), { added: 0, retired: 0 });
  // A retire list cannot accompany list -> all: every named ID is still served.
  assert.throws(() => cumulativeKmsAllowlist(list, all, KmsAllowlist.fromList(ids(1))), code("kms_allowlist_retire_still_served"));
  // all -> any list (even a superset, even with a retire list naming the removal) refuses.
  for (const next of [empty, list, KmsAllowlist.fromList(ids(1_000))]) {
    assert.throws(() => cumulativeKmsAllowlist(all, next, null), code("kms_allowlist_all_shrinks"));
    assert.throws(() => cumulativeKmsAllowlist(all, next, KmsAllowlist.fromList(ids(1, 5_000))), code("kms_allowlist_all_shrinks"));
  }
  // allow-all is never a retire list.
  assert.throws(() => cumulativeKmsAllowlist(list, empty, all), code("kms_allowlist_invalid"));
  assert.throws(() => cumulativeKmsAllowlist(all, all, all), code("kms_allowlist_invalid"));
});

test("allow-all deployment: accepted only for a staging/production CP hosted/escrow Worker of the bundled role", () => {
  for (const environment of ["staging", "production"]) for (const role of ["hosted", "escrow"] as const) {
    const b = allBundle(role);
    const value = deploymentKmsAllowlist(b, ALL_SHA, undefined, environment, cp(role));
    assert.equal(value.all, true); assert.ok(value.has(ids(1, 42_000)[0]));
    // An obsolete inherited secret stays inert, as for lists.
    assert.equal(deploymentKmsAllowlist(b, ALL_SHA, ids(2).join(","), environment, cp(role)).all, true);
    // Digest pin: the declared var must equal the module digest.
    for (const declared of [undefined, sha(""), ALL_SHA.toUpperCase()]) {
      assert.throws(() => deploymentKmsAllowlist(b, declared, undefined, environment, cp(role)), code("kms_allowlist_digest_mismatch"));
    }
    assert.throws(() => deploymentKmsAllowlist({ ...b, sha256: sha("") }, sha(""), undefined, environment, cp(role)), code("kms_allowlist_digest_mismatch"));
    // Not a CP deployment of exactly this role.
    const other: KmsAllowAllRole = role === "hosted" ? "escrow" : "hosted";
    for (const deployment of [undefined, { ...cp(role), serviceKind: undefined }, { ...cp(role), serviceKind: other },
      { ...cp(role), serviceKind: "migration" }, { ...cp(role), migration: true }, { ...cp(role), role: other }, cp(other)]) {
      assert.throws(() => deploymentKmsAllowlist(b, ALL_SHA, undefined, environment, deployment), code("kms_allowlist_all_refused"), JSON.stringify(deployment));
    }
  }
  // LAB/local never serve allow-all, with or without a secret.
  for (const environment of ["lab", "local"]) for (const role of ["hosted", "escrow"] as const) {
    for (const secret of [undefined, ids(2).join(",")]) {
      assert.throws(() => deploymentKmsAllowlist(allBundle(role), ALL_SHA, secret, environment, cp(role)), code("kms_allowlist_all_refused"));
    }
  }
});

test("allow-all module must name its CP role; a list module must not carry one", () => {
  const raw = { schema: KMS_ALLOWLIST_SCHEMA, sha256: ALL_SHA, text: KMS_ALLOW_ALL_TEXT };
  for (const role of [undefined, "", "migration", "Hosted", "all", null]) {
    const b = (role === undefined ? { ...raw } : { ...raw, role }) as unknown as BundledKmsAllowlist;
    assert.throws(() => deploymentKmsAllowlist(b, ALL_SHA, undefined, "staging", cp("hosted")), code("kms_allowlist_invalid"), String(role));
  }
  const list = bundle(ids(3));
  for (const role of ["hosted", "escrow", undefined]) {
    const b = { ...list, role } as unknown as BundledKmsAllowlist;
    assert.throws(() => deploymentKmsAllowlist(b, list.sha256, undefined, "staging", cp("hosted")), code("kms_allowlist_invalid"));
  }
  // A list module is unaffected by the deployment descriptor (migration Workers keep exact lists).
  for (const deployment of [undefined, cp("hosted"), { role: "hosted" as const, serviceKind: undefined, migration: true }]) {
    assert.equal(deploymentKmsAllowlist(list, list.sha256, undefined, "production", deployment).size, 3);
  }
});
