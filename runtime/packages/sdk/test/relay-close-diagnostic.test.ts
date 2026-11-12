import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pipeCloseError } from "../src/transport/relay-pipe.js";
import { relayCloseFromDetails } from "../src/transport/relay-close.js";

const classes = [
  [1000, "normal"], [1001, "going_away"], [1002, "protocol_error"], [1003, "unsupported_data"],
  [1005, "no_status"], [1006, "abnormal"], [1007, "invalid_payload"], [1008, "policy_violation"],
  [1009, "message_too_big"], [1010, "extension_required"], [1011, "internal_error"],
  [1012, "service_restart"], [1013, "try_again_later"], [1014, "bad_gateway"], [1015, "tls_failure"],
  [4000, "pipe_closed"], [4401, "unauthenticated"], [4403, "grant_inactive"],
  [4404, "connector_offline"], [4429, "connector_busy"], [4999, "other"],
] as const;

const grantRefusals = JSON.parse(readFileSync(new URL("../../../conformance/relay-grant-refusals.json", import.meta.url), "utf8")) as {
  name: string; reason: string; close_code: number;
}[];

describe("bounded relay close diagnostics", () => {
  it.each(grantRefusals)("preserves the daemon/server recovery contract for $name", ({ reason, close_code }) => {
    expect(pipeCloseError(close_code, reason)).toMatchObject({
      code: close_code === 4000 ? "unavailable" : "forbidden", reason,
    });
  });
  it.each(classes)("keeps numeric close code %i and fixed class %s without raw text", (code, closeClass) => {
    const raw = "PRIVATE_UNKNOWN_CLOSE_TEXT_/some/path?token=do-not-retain";
    const error = pipeCloseError(code, raw);
    expect(error.details).toEqual({ relayCloseCode: code, relayCloseClass: closeClass });
    expect(JSON.stringify({ message: error.message, problem: error.toProblem() })).not.toContain(raw);
    if (code < 4000 || code === 4999) expect(error).toMatchObject({ code: "unavailable", reason: "relay_closed" });
  });

  it.each([undefined, null, "1006", -1, 0, 999, 5000, 65535, NaN, Infinity, 1000.5])("does not retain an invalid code %s", code => {
    const error = pipeCloseError(code as number, "untrusted text");
    expect(error.details).toEqual({ relayCloseCode: null, relayCloseClass: "unknown" });
    expect(error.message).not.toContain("untrusted text");
  });

  it("reconstructs the class from numeric data and drops every unrelated detail", () => {
    const raw = "PRIVATE_UNKNOWN_CLASS_OR_EXTRA_FIELD";
    const details = { relayCloseCode: 4001, relayCloseClass: raw, extra: raw };
    expect(relayCloseFromDetails(details)).toEqual({ closeCode: 4001, closeClass: "other" });
    expect(Object.isFrozen(relayCloseFromDetails(details))).toBe(true);
    expect(relayCloseFromDetails(new Map([["relayCloseCode", 1006]]))).toBeUndefined();
    expect(relayCloseFromDetails({ extra: raw })).toBeUndefined();
    expect(relayCloseFromDetails({ relayCloseCode: raw })).toEqual({ closeCode: null, closeClass: "unknown" });
  });

  it.each([
    [4000, "device_key_mismatch", "unauthenticated", "device_key_mismatch"],
    [4000, "handshake_timeout", "unavailable", "handshake_timeout"],
    [4401, "unauthenticated", "unauthenticated", "relay_unauthenticated"],
    [4403, "grant_inactive", "forbidden", "grant_inactive"],
    [4403, "grant_revoked_on_device", "forbidden", "grant_revoked_on_device"],
    [4403, "grant_pending_approval", "forbidden", "grant_pending_approval"],
    [4403, "unknown_grant", "forbidden", "unknown_grant"],
    [4000, "grant_lease_expired", "unavailable", "grant_lease_expired"],
    [4404, "connector_offline", "unavailable", "no_device_online"],
    [4429, "connector_busy", "rate_limited", "connector_busy"],
  ] as const)("preserves known protocol recovery for %i/%s", (code, reason, wantCode, wantReason) => {
    expect(pipeCloseError(code, reason)).toMatchObject({ code: wantCode, reason: wantReason });
  });

  it("keeps lease expiry retryable with the existing retry hint", () => {
    expect(pipeCloseError(4000, "grant_lease_expired")).toMatchObject({ code: "unavailable", recovery: "retry", reason: "grant_lease_expired", retryAfterMs: 1000 });
  });
});
