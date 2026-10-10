import { describe, expect, it } from "vitest";
import { compareSemver, decideRole, type RuntimeInfo } from "../src/shared/skew.js";

const rt = (runtimeVersion: string, sem: [number, number], serves = [[1, 0], [1, 1]], speaks = serves): RuntimeInfo => ({
  abiMajor: 1,
  runtimeVersion,
  sem: { major: sem[0], minor: sem[1] },
  serves: serves.map(([major, minor]) => ({ major: major!, minor: minor! })),
  speaks: speaks.map(([major, minor]) => ({ major: major!, minor: minor! })),
});

describe("compareSemver", () => {
  it("orders per semver 2.0", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareSemver(order[i]!, order[i + 1]!)).toBe(-1);
      expect(compareSemver(order[i + 1]!, order[i]!)).toBe(1);
    }
    expect(compareSemver("1.2.3+build.5", "1.2.3")).toBe(0);
  });
});

describe("decideRole (replica-client-api §13)", () => {
  const base = { logSemMajor: 1, daemonHosts: false };
  it("first runtime hosts", () => {
    expect(decideRole({ ...base, me: rt("1.0.0", [1, 0]), host: null })).toEqual({ kind: "host" });
  });
  it("a runtime older than the log ratchet does not host", () => {
    expect(decideRole({ ...base, logSemMajor: 2, me: rt("1.0.0", [1, 0]), host: null })).toEqual({ kind: "upgrade_required", reason: "log_semantics_newer" });
  });
  it("the daemon wins on desktop", () => {
    expect(decideRole({ ...base, daemonHosts: true, me: rt("9.0.0", [9, 0]), host: null })).toEqual({ kind: "daemon" });
  });
  it("a newer runtime takes over by handoff", () => {
    expect(decideRole({ ...base, me: rt("1.1.0", [1, 0]), host: rt("1.0.0", [1, 0]) })).toEqual({ kind: "handoff", from: "1.0.0" });
    expect(decideRole({ ...base, me: rt("1.0.0", [1, 1]), host: rt("1.5.0", [1, 0]) })).toEqual({ kind: "handoff", from: "1.5.0" });
  });
  it("an older or equal runtime attaches as a client at the best common API", () => {
    expect(decideRole({ ...base, me: rt("1.0.0", [1, 0]), host: rt("1.1.0", [1, 0]) })).toEqual({ kind: "client", of: "1.1.0", api: { major: 1, minor: 1 } });
    expect(decideRole({ ...base, me: rt("1.1.0", [1, 0]), host: rt("1.1.0", [1, 0]) }).kind).toBe("client");
  });
  it("an older runtime whose API the host no longer serves must upgrade", () => {
    const me = rt("1.0.0", [1, 0], [[1, 0]]);
    const host = rt("2.0.0", [2, 0], [[2, 0]]);
    expect(decideRole({ ...base, me, host })).toEqual({ kind: "upgrade_required", reason: "host_api_incompatible" });
  });
  it("a newer runtime that may not host the log attaches instead of taking over", () => {
    expect(decideRole({ ...base, logSemMajor: 2, me: rt("1.9.0", [1, 5]), host: rt("2.0.0", [2, 0], [[1, 0], [1, 1]]) }).kind).toBe("client");
  });
});
