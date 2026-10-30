import { describe, expect, it } from "vitest";
import { webSignInProblem } from "../src/app-host/web-sign-in-problem.js";
import { AppCollectionJoinError } from "../src/app-host/collection-join-ledger.js";
import { AppCollectionControlError } from "../src/app-host/collection-control.js";
import { AppCloudCopyBootstrapError } from "../src/app-host/cloud-copy-bootstrap.js";
import { MdbaseError } from "../src/errors.js";
import { AppCloudCopyHostError } from "../src/app-host/cloud-copy-host.js";
import { appServerProblem } from "../src/app-host/cp-problem.js";

describe("bounded web sign-in diagnostic vocabulary", () => {
  it.each([new AppCollectionJoinError("recovery_required"), new AppCollectionControlError("recovery_required"), new AppCloudCopyBootstrapError("outcome_unknown")])("preserves explicit SDK predicates", error => {
    expect(webSignInProblem(error)).toMatchObject({problem: error.reason, detail: {code: error.reason}});
  });
  it.each([new TypeError("secret"), "secret", Object.assign(new Error("secret"), {name: "secret", code: "secret", reason: "recovery_required", cause: {bearer: "secret"}})])("never exports arbitrary exception text or fields", error => {
    const value = webSignInProblem(error);
    expect(value.problem).toBe("open_failed"); expect(value.detail.code).toBeNull();
    expect(JSON.stringify(value)).not.toContain("secret");
    expect(Object.keys(value.detail).sort()).toEqual(["code", "name"]);
    expect(Object.isFrozen(value.detail)).toBe(true);
  });
  it("exposes CP outcomes with the sanitized server problem", () => {
    const server = appServerProblem(409, {error: {code: "collection_migrating", message: "secret", details: {bearer: "secret"}}}, new Headers({"retry-after": "30"}));
    expect(webSignInProblem(new AppCloudCopyBootstrapError("collection_migrating", false, server))).toEqual({problem: "collection_migrating",
      detail: {name: "AppCloudCopyBootstrapError", code: "collection_migrating", server: {status: 409, code: "collection_migrating", reason: null, retryAfterMs: 30_000, updateUrl: null}}});
    expect(appServerProblem(409, {error: {code: "collection_unavailable", details: {reason: "moved_to_next_runtime", update_url: "javascript:alert(1)"}}}).updateUrl).toBeNull();
  });
  it("re-validates server detail on an SDK error instead of trusting the class", () => {
    const forged = {status: 409, code: "collection_migrating", reason: null, retryAfterMs: 1, updateUrl: "javascript:alert(1)"};
    expect(webSignInProblem(new AppCloudCopyBootstrapError("collection_migrating", false, forged as never)).detail.server)
      .toEqual({status: 409, code: "collection_migrating", reason: null, retryAfterMs: 5_000, updateUrl: null});
    for (const bad of [{...forged, message: "secret"}, {...forged, code: "Not A Code"}, {...forged, retryAfterMs: "soon"}, new Map()]) {
      const value = webSignInProblem(new AppCloudCopyBootstrapError("collection_migrating", false, bad as never));
      expect(value.detail.server).toBeUndefined(); expect(JSON.stringify(value)).not.toContain("secret");
    }
    expect(appServerProblem(409, {error: {code: "collection_unavailable", details: {update_url: "https://evil.example/update", retry_after_ms: 10 ** 9}}}))
      .toMatchObject({updateUrl: null, retryAfterMs: 600_000});
  });
  it("keeps a typed cold-sync stall in diagnostic detail without adding a public copy key", () => {
    expect(webSignInProblem(new AppCloudCopyHostError("sync_stalled"))).toEqual({problem: "unavailable", detail: {name: "AppCloudCopyHostError", code: "sync_stalled"}});
    expect(webSignInProblem(Object.assign(new Error("secret"), {reason: "sync_stalled"})).problem).toBe("open_failed");
  });
  it("exports only a known replica code, not its reason/body/custody", () => {
    expect(webSignInProblem(new MdbaseError({code: "unavailable", recovery: "retry", message: "secret", reason: "secret", details: new Map([["bearer", "secret"]])}))).toEqual({problem: "open_failed", detail: {name: "MdbaseError", code: "unavailable"}});
  });
  it("bounds DOM exception codes and survives hostile getters/proxies", () => {
    expect(webSignInProblem(new DOMException("secret", "QuotaExceededError"))).toEqual({problem: "open_failed", detail: {name: "DOMException", code: "QuotaExceededError"}});
    expect(webSignInProblem(new DOMException("secret", "secret"))).toEqual({problem: "open_failed", detail: {name: "DOMException", code: null}});
    const proxy = new Proxy({}, {getPrototypeOf() {throw Error("secret");}});
    expect(webSignInProblem(proxy)).toEqual({problem: "open_failed", detail: {name: "UnknownError", code: null}});
  });
});
