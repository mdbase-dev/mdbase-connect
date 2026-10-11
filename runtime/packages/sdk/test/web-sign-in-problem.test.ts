import { describe, expect, it } from "vitest";
import { webSignInProblem } from "../src/app-host/web-sign-in-problem.js";
import { AppCollectionJoinError } from "../src/app-host/collection-join-ledger.js";
import { AppCollectionControlError } from "../src/app-host/collection-control.js";
import { AppCloudCopyBootstrapError } from "../src/app-host/cloud-copy-bootstrap.js";
import { MdbaseError } from "../src/errors.js";

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
