import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApprovalError, ApproverApproval, JoinerApproval, sasCode, sasCommit, type EnrolledKeys } from "../src/keys/sasProtocol.js";

const COL = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
const A = { device: "11111111-2222-4333-8444-555555555555", signPk: new Uint8Array(32).fill(0xa1) };
const N: EnrolledKeys = { device: "4b1d2e3f-5a6b-4c7d-8e9f-a0b1c2d3e4f5", signPk: new Uint8Array(32).fill(0xb1), kemPk: new Uint8Array(32).fill(0xb2), noisePk: new Uint8Array(32).fill(0xb3) };
const uuid = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const H = (tag: string, ...parts: Uint8Array[]) => {
  const t = Buffer.from(tag);
  return createHash("sha256").update(Buffer.concat([Buffer.from([t.length]), t, ...parts])).digest();
};

describe("SAS commit-then-reveal (sealed-envelope §5.3)", () => {
  it("matches an independent computation of the contract formulas", async () => {
    const rA = new Uint8Array(32).fill(0x0a);
    const rN = new Uint8Array(32).fill(0x0b);
    const commit = H("mdbase/v1/sas-commit", uuid(COL), uuid(N.device), N.signPk, N.kemPk, N.noisePk, rN);
    expect(Buffer.from(await sasCommit(COL, N, rN)).equals(commit)).toBe(true);
    const h = H("mdbase/v1/sas", uuid(COL), uuid(A.device), uuid(N.device), A.signPk, N.signPk, N.kemPk, N.noisePk, rA, rN);
    const want = String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
    expect(await sasCode(COL, A, N, rA, rN)).toBe(want);
  });

  it("vectors for the Rust replica", async () => {
    const rA = new Uint8Array(32).fill(0x0a);
    const rN = new Uint8Array(32).fill(0x0b);
    // Recorded so the Rust implementation can assert the same values.
    expect(Buffer.from(await sasCommit(COL, N, rN)).toString("hex")).toMatchInlineSnapshot(`"025bcf77528c9da962a9b3f083a03fc6cb902b739b84c21b1acd7dd796de5f6f"`);
    expect(await sasCode(COL, A, N, rA, rN)).toMatchInlineSnapshot(`"012286"`);
  });

  async function run(joinerKeys: EnrolledKeys, approverView: EnrolledKeys) {
    const joiner = JoinerApproval.create(COL, joinerKeys);
    const enrolInLog = { ...approverView, sasCommit: approverView === joinerKeys ? await joiner.commitment() : approverView.sasCommit };
    await joiner.verifyOwnEnrol({ ...joinerKeys, sasCommit: await joiner.commitment() });
    const approver = new ApproverApproval(COL, A, enrolInLog);
    const rA = approver.challenge();
    const { reveal, sas: shownOnJoiner } = await joiner.onChallenge(A, rA, async () => {});
    return { joiner, approver, reveal, shownOnJoiner };
  }

  it("both devices show the same code, and the joiner accepts a grant only from its approver", async () => {
    const { joiner, approver, reveal, shownOnJoiner } = await run(N, N);
    const shownOnApprover = await approver.onReveal(reveal);
    expect(shownOnApprover).toBe(shownOnJoiner);
    expect(approver.confirm(shownOnJoiner)).toBe("approved");
    expect(joiner.acceptsGrantFrom(A.device)).toBe(true);
    expect(joiner.acceptsGrantFrom("99999999-2222-4333-8444-555555555555")).toBe(false);
  });

  it("an enrol item the control plane altered is refused by the new device", async () => {
    const joiner = JoinerApproval.create(COL, N);
    const commit = await joiner.commitment();
    await expect(joiner.verifyOwnEnrol({ ...N, kemPk: new Uint8Array(32).fill(0xee), sasCommit: commit })).rejects.toThrow(ApprovalError);
    await expect(joiner.onChallenge(A, new Uint8Array(32), async () => {})).rejects.toMatchObject({ reason: "wrong_state" });
  });

  it("a substituted device cannot pick r_N after seeing r_A (commitment binds it)", async () => {
    // The attacker enrols its own device with some commitment, receives r_A, and tries
    // to reveal a different r_N chosen to make the code match the real device's code.
    const attacker: EnrolledKeys = { ...N, device: "deadbeef-2222-4333-8444-555555555555", signPk: new Uint8Array(32).fill(0xcc) };
    const committed = new Uint8Array(32).fill(1);
    const approver = new ApproverApproval(COL, A, { ...attacker, sasCommit: await sasCommit(COL, attacker, committed) });
    approver.challenge();
    await expect(approver.onReveal(new Uint8Array(32).fill(2))).rejects.toMatchObject({ reason: "commitment_mismatch" });
  });

  it("refuses a device enrolled without a commitment", () => {
    expect(() => new ApproverApproval(COL, A, N)).toThrow(ApprovalError);
  });

  it("locks after three wrong codes", async () => {
    const { approver, reveal } = await run(N, N);
    await approver.onReveal(reveal);
    expect(approver.confirm("000000")).toBe("mismatch");
    expect(approver.confirm("000001")).toBe("mismatch");
    expect(approver.confirm("000002")).toBe("mismatch");
    expect(() => approver.confirm("000003")).toThrow(/too_many_attempts/);
    expect(() => approver.challenge()).toThrow(/too_many_attempts/);
  });

  it("restores the joiner after a restart from the stored r_N", async () => {
    const j1 = JoinerApproval.create(COL, N);
    const j2 = JoinerApproval.restore(COL, N, j1.secretState);
    expect(await j2.commitment()).toEqual(await j1.commitment());
  });

  it("reveals r_N at most once, persisting that before revealing", async () => {
    const joiner = JoinerApproval.create(COL, N);
    await joiner.verifyOwnEnrol({ ...N, sasCommit: await joiner.commitment() });
    const persisted: Uint8Array[] = [];
    // An attacker's fake first challenge gets the reveal...
    const first = await joiner.onChallenge({ device: "deadbeef-2222-4333-8444-555555555555", signPk: new Uint8Array(32).fill(9) }, new Uint8Array(32).fill(1), async (st) => {
      persisted.push(st);
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]![32]).toBe(1);
    expect(first.reveal).toHaveLength(32);
    // ...and every later challenge, including the real approver's, is refused.
    await expect(joiner.onChallenge(A, new Uint8Array(32).fill(2), async () => {})).rejects.toMatchObject({ reason: "already_revealed" });
    // The revealed flag survives a restart.
    const restored = JoinerApproval.restore(COL, N, persisted[0]!);
    expect(restored.isRevealed).toBe(true);
  });

  it("a crash while persisting the reveal never reveals", async () => {
    const joiner = JoinerApproval.create(COL, N);
    await joiner.verifyOwnEnrol({ ...N, sasCommit: await joiner.commitment() });
    await expect(joiner.onChallenge(A, new Uint8Array(32), async () => Promise.reject(new Error("disk")))).rejects.toThrow("disk");
    await expect(joiner.onChallenge(A, new Uint8Array(32), async () => {})).rejects.toMatchObject({ reason: "already_revealed" });
  });

  it("retries with a fresh commitment through approval-request", async () => {
    let joiner = JoinerApproval.create(COL, N);
    const c1 = await joiner.commitment();
    await joiner.verifyOwnEnrol({ ...N, sasCommit: c1 });
    await joiner.onChallenge(A, new Uint8Array(32), async () => {});
    joiner = joiner.renew();
    const c2 = await joiner.commitment();
    expect(Buffer.from(c2).equals(Buffer.from(c1))).toBe(false);
    await joiner.verifyOwnEnrol(N); // keys only; the enrol item's key 7 is stale now
    await joiner.verifyOwnCommitment(N.device, c2); // the approval-request in the log
    const approver = new ApproverApproval(COL, A, { ...N, sasCommit: c2 });
    const rA = approver.challenge();
    expect(() => approver.challenge()).toThrow(/already/);
    const r = await joiner.onChallenge(A, rA, async () => {});
    expect(await approver.onReveal(r.reveal)).toBe(r.sas);
  });

  it("a commitment the control plane appended makes the new device show no code", async () => {
    const joiner = JoinerApproval.create(COL, N);
    await joiner.verifyOwnEnrol({ ...N, sasCommit: await joiner.commitment() });
    await expect(joiner.verifyOwnCommitment(N.device, new Uint8Array(32).fill(7))).rejects.toMatchObject({ reason: "enrol_mismatch" });
    await expect(joiner.onChallenge(A, new Uint8Array(32), async () => {})).rejects.toMatchObject({ reason: "wrong_state" });
  });
});
