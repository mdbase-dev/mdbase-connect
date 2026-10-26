import {test} from "node:test";
import assert from "node:assert/strict";
import {validateVersionedAppManifest, parseVersionedAppManifest, isNativeLoopbackOrigin} from "../dist/manifest.js";
const manifest = (origin, platform = "native", version = 2) => ({manifest_version:1, id:"dev.example.native", name:"Native", ...(platform ? {platform} : {}), homepage:origin, redirect_uris:[`${origin}/callback`], requirements:{access:"full_collection", contracts:[], ...(version === 2 ? {capabilities:{contract_version:2,required:["collection.read"]}} : {})}});
test("native declaration accepts any valid literal loopback port in production for both contracts", () => {
  for (const version of [1,2]) for (const origin of ["http://127.0.0.1", "http://127.0.0.1:1", "http://127.0.0.1:48218", "http://127.0.0.1:65535"]) {
    assert.equal(isNativeLoopbackOrigin(origin),true);
    assert.equal(validateVersionedAppManifest(manifest(origin, "native", version)).valid,true);
    assert.equal(validateVersionedAppManifest(manifest(origin, null, version)).valid,false);
    assert.equal(parseVersionedAppManifest(manifest(origin, "native", version)).manifest.platform,"native");
  }
});
test("native never admits localhost, other addresses, aliases, opaque origins or malformed ports", () => {
  for (const origin of ["http://localhost:48218", "http://x.localhost:48218", "http://127.0.0.2:48218", "http://192.168.1.1:48218", "http://[::1]:48218", "http://127.1:48218", "http://2130706433:48218", "http://127.0.0.1.evil.test:48218", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://user@127.0.0.1:48218", "app://obsidian.md"]) {
    assert.equal(isNativeLoopbackOrigin(origin),false,origin);
    assert.equal(validateVersionedAppManifest(manifest(origin)).valid,false,origin);
  }
});
test("native installation origins require the declaration; callbacks remain exact same-origin", () => {
  for (const platform of [undefined, "native"]) {
    const base=manifest("https://app.example.test",platform ?? null);
    const optional={...base,installation_origins:{production:{"app-runtime":["http://127.0.0.1:49152"]}}};
    assert.equal(validateVersionedAppManifest(optional).valid,platform === "native");
    for(const origin of ["http://localhost:49152", "app://obsidian.md", "http://127.0.0.2:49152"])
      assert.equal(validateVersionedAppManifest({...optional,installation_origins:{production:{"app-runtime":[origin]}}}).valid,false);
  }
  for(const callback of ["http://127.0.0.1:49153/callback", "app://obsidian.md/callback", "http://localhost:49152/callback"])
    assert.equal(validateVersionedAppManifest({...manifest("http://127.0.0.1:49152"),redirect_uris:[callback]}).valid,false);
  assert.equal(validateVersionedAppManifest({...manifest("http://127.0.0.1:49152"),platform:"other"}).valid,false);
  assert.equal(validateVersionedAppManifest({...manifest("http://127.0.0.1:49152"),distribution:"portable"}).valid,false);
});
