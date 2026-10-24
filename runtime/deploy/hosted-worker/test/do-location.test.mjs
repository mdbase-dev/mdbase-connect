import { test } from "node:test";
import assert from "node:assert/strict";
import { locationHint, namedStub, parseLocationHint } from "../src/do-location.ts";

const namespace = () => {
  const calls = [];
  return { calls, idFromName: name => `id:${name}`, get: (...args) => { calls.push(args); return { args }; } };
};

test("a configured hint reaches every new stub; unset keeps the one-argument default", () => {
  const ns = namespace();
  namedStub(ns, "c1", locationHint({ HOSTED_DO_LOCATION_HINT: "oc" }));
  namedStub(ns, "c2", locationHint({}));
  namedStub(ns, "c3", locationHint({ HOSTED_DO_LOCATION_HINT: "" }));
  assert.deepEqual(ns.calls, [["id:c1", { locationHint: "oc" }], ["id:c2"], ["id:c3"]]);
});

test("an unknown hint is refused, never silently defaulted", () => {
  for (const bad of ["OC", "syd", "sam", "oc,apac", 1]) assert.equal(parseLocationHint(bad), null);
  const ns = namespace();
  assert.throws(() => namedStub(ns, "c", null), /HOSTED_DO_LOCATION_HINT/);
  assert.deepEqual(ns.calls, []);
});

test("a creating request's region places the new actor; absent or default uses the configured default", async () => {
  const { parseRegion } = await import("../src/do-location.ts");
  for (const r of ["oc", "apac", "wnam", "enam", "weur"]) assert.equal(parseRegion(r), r);
  assert.equal(parseRegion(undefined), undefined);
  assert.equal(parseRegion("default"), undefined);
  for (const bad of ["sam", "OC", "", null, 1]) assert.equal(parseRegion(bad), null);
  const ns = namespace();
  const fallback = locationHint({ HOSTED_DO_LOCATION_HINT: "oc" });
  namedStub(ns, "c1", parseRegion("wnam") ?? fallback);
  namedStub(ns, "c2", parseRegion(undefined) ?? fallback);
  assert.deepEqual(ns.calls, [["id:c1", { locationHint: "wnam" }], ["id:c2", { locationHint: "oc" }]]);
});

test("activation and migration admission accept an optional region and refuse an unknown one", async () => {
  const { serviceActivation } = await import("../src/service-devices.ts");
  const { migrationAdmissionRequest } = await import("../src/migration-admission.ts");
  const token = "t".repeat(32);
  const post = body => new Request("https://hosted/x", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const collection = "0123abcd-0000-4000-8000-0000000000aa";
  const challenge = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  assert.deepEqual(await serviceActivation(post({ collection }), token), { collection });
  assert.deepEqual(await serviceActivation(post({ collection, region: "wnam" }), token), { collection, region: "wnam" });
  assert.deepEqual(await serviceActivation(post({ collection, region: "default" }), token), { collection });
  assert.equal((await serviceActivation(post({ collection, region: "sam" }), token)).status, 400);
  assert.deepEqual(await migrationAdmissionRequest(post({ collection, challenge, region: "oc" }), token), { collection, challenge, region: "oc" });
  assert.deepEqual(await migrationAdmissionRequest(post({ collection, challenge }), token), { collection, challenge });
  assert.equal((await migrationAdmissionRequest(post({ collection, challenge, region: "mars" }), token)).status, 400);
  assert.equal((await migrationAdmissionRequest(post({ collection, challenge, extra: 1 }), token)).status, 400);
});
