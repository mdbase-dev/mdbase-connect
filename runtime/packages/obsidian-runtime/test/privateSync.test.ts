// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { COLLECTION_OPTIONS, DEFAULT_COLLECTION_OPTION, DeviceApproval, describePrivateSync, recoverFromKey, RecoveryKeySetup, type PrivateSyncApi, type PrivateSyncFacts } from "../src/keys/privateSync.js";
import { formatRecoveryKey } from "../src/keys/recoveryKey.js";
import { renderApprovals, renderPrivateSyncStatus } from "../src/keys/ui.js";

const base: PrivateSyncFacts = {
  state: "private",
  keyed: true,
  canApprove: true,
  connection: "online",
  pending: [],
  ownSas: null,
  approversOnline: null,
  recovery: "enrolled",
  recoveryKeyDismissed: false,
  keyProtection: "keychain",
  identityLost: false,
};

function api(over: Partial<PrivateSyncApi> = {}): PrivateSyncApi & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    pendingDevices: async () => [{ device: "d1", account: "a", kind: "mobile" }],
    startApproval: async () => ({ ok: true as const, sas: "042917" }),
    approveDevice: async (d) => {
      approved.push(d);
    },
    rejectDevice: async () => {},
    requestApprovalAgain: async () => {},
    enrolRecoveryKey: async () => {},
    recoverWithKey: async () => {},
    ...over,
  };
}

describe("describePrivateSync", () => {
  it("offers only Cloud copy and Private, defaulting to Cloud copy", () => {
    expect(COLLECTION_OPTIONS.map(option => [option.state, option.title])).toEqual([
      ["cloud-copy", "Cloud copy"], ["private", "Private"],
    ]);
    expect(DEFAULT_COLLECTION_OPTION).toBe("cloud-copy");
  });
  it("shows advanced Sync: off with a prompt to enable one of the two options", () => {
    const view = describePrivateSync({ ...base, state: "local-only" });
    expect(view.title).toBe("Sync: off");
    expect(view.tone).toBe("attention");
    expect(view.body.join(" ")).toMatch(/Turn sync on.*Private or Cloud copy/);
    expect(view.actions).toEqual([]);
  });
  it("explains hosted availability for Cloud copy and device availability for Private", () => {
    const cloud = describePrivateSync({ ...base, state: "cloud-copy" });
    expect(cloud.title).toBe("Cloud copy");
    expect(cloud.body.join(" ")).toMatch(/hosted even when your devices are off/);
    const privateView = describePrivateSync(base);
    expect(privateView.title).toBe("Private");
    expect(privateView.body.join(" ")).toMatch(/End-to-end synced.*one of your devices online/);
  });
  it("waiting device shows its code and says when nobody can approve", () => {
    const v = describePrivateSync({ ...base, keyed: false, canApprove: false, ownSas: "042917", approversOnline: 0 });
    expect(v.tone).toBe("waiting");
    expect(v.code).toBe("042 917");
    expect(v.body.join(" ")).toMatch(/None of your other devices is online/);
    expect(v.actions).toContain("use-recovery-key");
  });
  it("waiting before any challenge tells the user where to start approval", () => {
    const v = describePrivateSync({ ...base, keyed: false, ownSas: null, approversOnline: 1 });
    expect(v.code).toBeNull();
    expect(v.body.join(" ")).toMatch(/Review devices/);
  });
  it("after a spent reveal, asks to request approval again", () => {
    const v = describePrivateSync({ ...base, keyed: false, needsNewApprovalRequest: true });
    expect(v.actions[0]).toBe("request-approval");
    expect(v.code).toBeNull();
  });
  it("waiting while offline says so", () => {
    const v = describePrivateSync({ ...base, keyed: false, connection: "offline", ownSas: "000001" });
    expect(v.body.join(" ")).toMatch(/offline/);
    expect(v.actions[0]).toBe("retry-connection");
  });
  it("keyed device with pending approvals asks for review", () => {
    const v = describePrivateSync({ ...base, pending: [{ device: "d", account: "a", kind: "mobile" }] });
    expect(v.tone).toBe("attention");
    expect(v.actions).toEqual(["approve-devices"]);
  });
  it("viewers are not asked to approve", () => {
    const v = describePrivateSync({ ...base, canApprove: false, pending: [{ device: "d", account: "a", kind: "mobile" }] });
    expect(v.actions).toEqual([]);
  });
  it("offers a recovery key until set up or dismissed", () => {
    expect(describePrivateSync({ ...base, recovery: "none" }).actions).toEqual(["set-up-recovery-key"]);
    expect(describePrivateSync({ ...base, recovery: "none", recoveryKeyDismissed: true }).actions).toEqual([]);
  });
  it("alerts on every device when the recovery key is revoked", () => {
    const v = describePrivateSync({ ...base, recovery: "revoked", recoveryKeyDismissed: true });
    expect(v.tone).toBe("error");
    expect(v.title).toMatch(/recovery key was removed/);
  });
  it("asks to rotate a used recovery key", () => {
    expect(describePrivateSync({ ...base, recovery: "used" }).actions).toEqual(["replace-recovery-key"]);
  });
  it("lost identity is an error with a way forward", () => {
    const v = describePrivateSync({ ...base, identityLost: true });
    expect(v.tone).toBe("error");
    expect(v.actions).toEqual(["enrol-again", "use-recovery-key"]);
  });
});

describe("flows", () => {
  it("approves only after start, with the code typed from the new device, and locks after 3 misses", async () => {
    const a = api();
    const flow = new DeviceApproval(a, "d1");
    expect(await flow.confirm("042917")).toEqual({ ok: false, problem: "not_started" });
    expect(await flow.start()).toEqual({ ok: true });
    expect(await flow.confirm("42917")).toEqual({ ok: false, problem: "format" });
    expect(await flow.confirm("042 918")).toEqual({ ok: false, problem: "mismatch", attemptsLeft: 2 });
    expect(a.approved).toEqual([]);
    expect(await flow.confirm("042-917")).toEqual({ ok: true });
    expect(a.approved).toEqual(["d1"]);
    const locked = new DeviceApproval(api(), "d1");
    await locked.start();
    await locked.confirm("000000");
    await locked.confirm("000000");
    expect(await locked.confirm("000000")).toEqual({ ok: false, problem: "locked" });
    expect(await locked.confirm("042917")).toEqual({ ok: false, problem: "locked" });
    expect(await locked.start()).toEqual({ ok: false, reason: "too_many_attempts" });
  });
  it("a device that left is reported", async () => {
    const flow = new DeviceApproval(api({ pendingDevices: async () => [] }), "d1");
    await flow.start();
    expect(await flow.confirm("042917")).toEqual({ ok: false, problem: "gone" });
  });
  it("recovery key setup requires the last group and wipes the secret", async () => {
    const secret = new Uint8Array(32).fill(9);
    const setup = await RecoveryKeySetup.create(secret);
    const enrol = vi.fn(async () => {});
    const a = api({ enrolRecoveryKey: enrol });
    expect(await setup.enrol(a, "WRONG")).toBe(false);
    expect(enrol).not.toHaveBeenCalled();
    expect(await setup.enrol(a, setup.confirmGroup.toLowerCase())).toBe(true);
    expect(enrol).toHaveBeenCalledOnce();
    expect(secret.every((b) => b === 0)).toBe(true);
  });
  it("recovery import reports typos and keys the device on success", async () => {
    const recover = vi.fn(async () => {});
    const a = api({ recoverWithKey: recover });
    expect(await recoverFromKey(a, "MDB1-NOPE")).toEqual({ ok: false, problem: "wrong_length" });
    const f = await formatRecoveryKey(new Uint8Array(32).fill(3));
    expect(await recoverFromKey(a, f)).toEqual({ ok: true });
    expect(recover).toHaveBeenCalledOnce();
  });
});

describe("ui", () => {
  it("renders the migration/advanced sync-off prompt without a third product option", () => {
    const root = renderPrivateSyncStatus(document.body, describePrivateSync({ ...base, state: "local-only" }), () => {});
    expect(root.textContent).toContain("Sync: off");
    expect(root.textContent).toContain("Private or Cloud copy");
    expect(root.textContent).not.toContain("Local only");
    expect(root.querySelector("button")).toBeNull();
  });
  it("renders the waiting code and actions", () => {
    const actions: string[] = [];
    const root = renderPrivateSyncStatus(document.body, describePrivateSync({ ...base, keyed: false, ownSas: "042917", approversOnline: 0 }), (a) => actions.push(a));
    expect(root.querySelector(".mdbase-sas-code")!.textContent).toBe("042 917");
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(actions).toEqual(["use-recovery-key"]);
  });
  it("approval list: start, then type the code shown on the new device", async () => {
    const a = api();
    const root = renderApprovals(document.body, await a.pendingDevices(), { approval: (d) => new DeviceApproval(a, d), reject: async () => {} });
    const [start, approve] = Array.from(root.querySelectorAll("button.mod-cta")) as HTMLButtonElement[];
    const input = root.querySelector("input") as HTMLInputElement;
    expect(root.textContent).not.toContain("042"); // this device never shows its copy of the code
    start!.click();
    await vi.waitFor(() => expect(input.style.display).toBe(""));
    input.value = "042917";
    approve!.click();
    await vi.waitFor(() => expect(a.approved).toEqual(["d1"]));
    expect(root.querySelector(".mdbase-approval")!.classList.contains("is-approved")).toBe(true);
  });
});
