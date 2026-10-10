import { test } from "node:test";
import assert from "node:assert/strict";
import { labHealth } from "../src/health.ts";

const request = (path = "/health", method = "GET") => new Request(`https://worker.test${path}`, { method });

test("LAB liveness returns only fixed metadata, never readiness or identifiers", async () => {
  const response = labHealth(request("/health?collection=private&token=secret"), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("liveness is absent unless LAB is explicitly enabled and path is exact", () => {
  assert.equal(labHealth(request()), null);
  assert.equal(labHealth(request(), false), null);
  for (const path of ["/health/", "/healthz", "/v1/hosted/status", "/internal/v1/service-devices"]) {
    assert.equal(labHealth(request(path), true), null);
  }
});

test("HEAD is bodyless; other methods cannot turn liveness into an effect", async () => {
  const head = labHealth(request("/health", "HEAD"), true);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = labHealth(request("/health", method), true);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(await response.text(), "");
  }
});
