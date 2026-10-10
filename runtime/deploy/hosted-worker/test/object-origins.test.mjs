import test from "node:test";
import assert from "node:assert/strict";
import { ObjectOriginPolicy, DENY_OBJECT_ORIGINS, deploymentObjectOrigins } from "../src/object-origins.ts";

test("deployment origins are exact scheme/host/port snapshots, not suffix/wildcard matches", () => {
  const input = ["https://objects.test", "https://other.test:8443/"];
  const p = ObjectOriginPolicy.configured(input);
  input[0] = "https://changed.test"; input.push("https://new.test");
  for (const uri of ["https://objects.test/sealed?signature=test-only", "https://objects.test:443/x", "https://other.test:8443/x"]) {
    const d = p.destination(uri); assert.equal(d.viaLog, false);
  }
  for (const uri of ["http://objects.test/x", "https://objects.test:444/x", "https://other.test/x", "https://changed.test/x", "https://new.test/x",
    "https://sub.objects.test/x", "https://objects.test.evil.test/x", "https://objects.test./x"]) assert.throws(() => p.destination(uri));
});

test("missing/invalid configuration denies destinations; configured IP/local/private targets refused", () => {
  const bad = ["https://127.0.0.1", "https://10.0.0.1", "https://169.254.169.254", "https://8.8.8.8", "https://[::1]", "https://[2001:4860:4860::8888]",
    "https://2130706433", "https://0x7f000001", "https://localhost", "https://bucket.localhost", "https://bucket.local", "https://bucket.internal", "https://singlelabel",
    "https://objects.test/path", "https://objects.test?query", "https://objects.test#", "https://objects.test.", "https://*.objects.test", "https://objects.test:443",
    "https://user:secret@objects.test", "https://@objects.test", "https://objects.test\\path", " https://objects.test", "http://objects.test"];
  for (const origin of bad) {
    assert.throws(() => ObjectOriginPolicy.configured([origin]), origin);
    if (origin === origin.trim()) // deployment CSV permits surrounding whitespace
      assert.throws(() => deploymentObjectOrigins({ OBJECT_STORAGE_ORIGINS: origin, LOG: {} }).destination("https://log.internal/x"));
  }
  assert.throws(() => ObjectOriginPolicy.configured(["https://objects.test", "https://objects.test/"]));
  assert.throws(() => ObjectOriginPolicy.configured(Array.from({length: 17}, (_, i) => `https://bucket${i}.test`)));
  for (const p of [DENY_OBJECT_ORIGINS, deploymentObjectOrigins({}), deploymentObjectOrigins({OBJECT_STORAGE_ORIGINS: "https://objects.test,,https://other.test"})])
    assert.throws(() => p.destination("https://objects.test/x"));
  assert.throws(() => deploymentObjectOrigins({OBJECT_STORAGE_ORIGINS: "x".repeat(8193)}).destination("https://objects.test/x"));
});

test("capability credentials/fragments/ambiguous lexical URLs are refused even at a trusted origin", () => {
  const p = ObjectOriginPolicy.configured(["https://objects.test"]);
  for (const uri of ["https://user:secret@objects.test/x", "https://@objects.test/x", "https://objects.test/x#", "https://objects.test/x#frag",
    "https:objects.test/x", " https://objects.test/x", "https://objects.test/\nx", "https://objects.test\\x", "https://objects.test/ x"]) assert.throws(() => p.destination(uri));
});

test("log.internal requires explicit real service binding and never routes through ordinary fetch", () => {
  assert.throws(() => ObjectOriginPolicy.configured(["https://log.internal"]));
  assert.throws(() => DENY_OBJECT_ORIGINS.destination("https://log.internal/direct"));
  assert.throws(() => deploymentObjectOrigins({OBJECT_STORAGE_ORIGINS: "https://objects.test"}).destination("https://log.internal/direct"));
  const p = deploymentObjectOrigins({LOG: {}});
  assert.equal(p.destination("https://log.internal/direct?opaque=test-only").viaLog, true);
  assert.throws(() => p.destination("https://log.internal:444/direct"));
  assert.throws(() => p.destination("https://log.internal.evil.test/direct"));
  assert.throws(() => p.destination("https://objects.test/direct"));
});
