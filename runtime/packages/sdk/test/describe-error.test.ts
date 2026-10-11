import { COLLECTION_DELETE_CODES } from "../src/app-host/collection-delete.js";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/describe-error.js";
import { MdbaseError } from "../src/errors.js";

describe("describeError", () => {
  it("gives the CP outcomes plain copy, retry timing and a safe update link", () => {
    const migrating = describeError({status: "blocked", problem: "collection_migrating", problemDetail: {name: "AppCloudCopyBootstrapError", code: "collection_migrating",
      server: {status: 409, code: "collection_migrating", reason: null, retryAfterMs: 45_000, updateUrl: null}}});
    expect(migrating).toMatchObject({key: "collection_migrating", title: "Your collection is being upgraded", action: "wait", transient: true, retryAfterMs: 45_000});
    expect(describeError("account_suspended")).toMatchObject({action: "contact_support", actionLabel: "Contact support", severity: "error"});
    const server = {status: 409, code: "collection_unavailable", reason: "moved_to_next_runtime", retryAfterMs: null, updateUrl: "https://mdbase.dev/downloads/app"};
    expect(describeError({reason: "update_required", server}))
      .toMatchObject({key: "update_required", action: "update_app", updateUrl: "https://mdbase.dev/downloads/app"});
    expect(describeError(new MdbaseError({code: "unavailable", recovery: "retry", message: "secret", reason: "collection_migrating"}))?.key).toBe("collection_migrating");
  });
  it("treats forged server detail as untrusted: allowlisted links, clamped retry, no server copy", () => {
    const server = {status: 409, code: "collection_unavailable", reason: "moved_to_next_runtime", retryAfterMs: 1, updateUrl: "javascript:alert(1)"};
    for (const updateUrl of ["javascript:alert(1)", "https://evil.example/update", "https://user:pw@mdbase.dev/", "http://mdbase.dev/"]) {
      expect(describeError({reason: "update_required", server: {...server, updateUrl}})?.updateUrl).toBe("https://mdbase.dev/downloads/");
    }
    expect(describeError({reason: "update_required", server: {...server, updateUrl: "https://cp.example.test/update"}}, {cpOrigin: "https://cp.example.test"})?.updateUrl)
      .toBe("https://cp.example.test/update");
    expect(describeError({problem: "collection_migrating", problemDetail: {server: {...server, reason: null, code: "collection_migrating", retryAfterMs: 10 ** 9}}})?.retryAfterMs).toBe(600_000);
    // Extra fields (a server message) disqualify the detail; the own code still describes it.
    const own = describeError({reason: "refused", server: {...server, message: "secret server text"}})!;
    expect(own.key).toBe("refused"); expect(JSON.stringify(own)).not.toContain("secret");
  });
  it("describes every collection delete outcome with SDK copy, including a Worker reply error", () => {
    for (const code of COLLECTION_DELETE_CODES) {
      const d = describeError({code, message: "raw"})!;
      expect(d.key).toBe(code); expect(d.message).not.toContain("raw"); expect(d.message).not.toContain(code);
    }
    expect(describeError({code: "collection_delete_name_mismatch"})).toMatchObject({title: "The name doesn't match", action: "none"});
    expect(describeError({code: "collection_delete_outcome_unknown"})?.action).toBe("resolve_outcome");
  });
  it("never throws on codes that collide with Object.prototype names", () => {
    for (const code of ["constructor", "tostring", "hasownproperty", "valueof"]) {
      expect(describeError(code)).toMatchObject({key: "unknown", action: "reload"});
      expect(describeError({reason: "refused", server: {status: 400, code, reason: code, retryAfterMs: null, updateUrl: null}})?.key).toBe("refused");
    }
    expect(describeError({code: "__proto__"})).toBeNull();
    expect(describeError({problem: {code: "constructor"}})?.key).toBe("unknown");
  });
  it("covers readiness facets and falls back by suffix without showing raw codes", () => {
    expect(describeError({checking: false, assessment: {status: "ready", problem: null}, problem: {code: "notifications_consent_required"}})).toMatchObject({action: "approve", title: "Allow reminders"});
    expect(describeError({status: "setup_required", problem: null, readiness: {checking: false, assessment: {status: "setup_required", problem: null}, problem: null}})?.action).toBe("set_up");
    expect(describeError({status: "ready", problem: null, readiness: {checking: false, assessment: {status: "ready", problem: null}, problem: null}})).toBeNull();
    expect(describeError("application_worker_busy")).toMatchObject({key: "busy", transient: true});
    const unknown = describeError("application_something_binding")!;
    expect(unknown).toMatchObject({key: "unknown", action: "reload", code: "application_something_binding"});
    expect(unknown.message).not.toContain("application_");
  });
  it("gives a blocked snapshot's registration refusal developer detail from typed paths only", () => {
    const snapshot = { status: "blocked", problem: "application_registration_refused",
      problemDetail: { name: "MdbaseError", code: "forbidden", registration: { code: "invalid_application_manifest", paths: ["/homepage", "javascript:alert(1)", "/icon"] } } };
    expect(describeError(snapshot)).toMatchObject({
      key: "application_registration_refused", message: "This app can't connect right now. Contact the app's developer.",
      developerMessage: "This app's registration was rejected (invalid manifest: /homepage, /icon).",
    });
    expect(describeError("not_found")?.developerMessage).toBeNull();
  });
});
