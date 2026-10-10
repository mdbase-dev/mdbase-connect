/**
 * Device approval by commit-then-reveal SAS (`sealed-envelope.md` §5.3). It follows
 * the SAS-MCA pattern of Vaudenay
 * (2005), as ZRTP and Bluetooth numeric comparison use it.
 *
 * A code computed only from public keys can be ground by whoever enrols the
 * device. So each side contributes a 32-byte random value, and the new device `N`
 * commits to its value `r_N` in its `device-enrol` before the approver `A` draws
 * `r_A`:
 *
 *     sas_commit = H("mdbase/v1/sas-commit", collection ‖ N ‖ sign_pk_N ‖ kem_pk_N ‖ noise_pk_N ‖ r_N)
 *     sas        = u32be(H("mdbase/v1/sas", collection ‖ A ‖ N ‖ sign_pk_A ‖ sign_pk_N
 *                                          ‖ kem_pk_N ‖ noise_pk_N ‖ r_A ‖ r_N)[0..4]) mod 10^6
 *
 * Both sides are here:
 * - {@link JoinerApproval} for the new device. Mobile is often the new device.
 * - {@link ApproverApproval} for the keyed device. A phone can approve a laptop.
 *
 * Both take public keys **from their own view of the log** (the enrol items), never
 * from the channel. The channel that carries `r_A` and `r_N` needs no integrity:
 * tampering only produces mismatching codes.
 *
 * The Rust replica implements the same functions. `test/sasProtocol.test.ts`
 * holds vectors to share with it.
 */

import { concat, domainHash, uuidBytes } from "../util/hash.js";
import { sasEqual } from "./sas.js";

/** The public keys of an enrolled device, as its `device-enrol` item carries them. */
export interface EnrolledKeys {
  readonly device: string;
  readonly signPk: Uint8Array;
  readonly kemPk: Uint8Array;
  readonly noisePk: Uint8Array;
  /** `device-enrol` key 7. Required for approval in `e2e` collections. */
  readonly sasCommit?: Uint8Array;
}

/** Thrown when a protocol rule is broken. */
export class ApprovalError extends Error {
  constructor(
    readonly reason:
      | "commitment_mismatch"
      | "enrol_mismatch"
      | "no_commitment"
      | "too_many_attempts"
      | "wrong_state"
      | "already_revealed"
      | "bad_length",
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "ApprovalError";
  }
}

/** Failed confirmations per enrolled device before a fresh enrolment is required. */
export const MAX_ATTEMPTS = 3;

function len32(...xs: Uint8Array[]): void {
  for (const x of xs) if (x.length !== 32) throw new ApprovalError("bad_length", "keys and random values are 32 bytes");
}

/** `sas_commit` for the new device. */
export async function sasCommit(collection: string, n: EnrolledKeys, rN: Uint8Array): Promise<Uint8Array> {
  len32(n.signPk, n.kemPk, n.noisePk, rN);
  return domainHash("mdbase/v1/sas-commit", concat(uuidBytes(collection), uuidBytes(n.device), n.signPk, n.kemPk, n.noisePk, rN));
}

/** The six-digit code both devices show. */
export async function sasCode(collection: string, a: { device: string; signPk: Uint8Array }, n: EnrolledKeys, rA: Uint8Array, rN: Uint8Array): Promise<string> {
  len32(a.signPk, n.signPk, n.kemPk, n.noisePk, rA, rN);
  const h = await domainHash(
    "mdbase/v1/sas",
    concat(uuidBytes(collection), uuidBytes(a.device), uuidBytes(n.device), a.signPk, n.signPk, n.kemPk, n.noisePk, rA, rN),
  );
  const x = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(x % 1_000_000).padStart(6, "0");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

/** Persisted joiner state: `r_N ‖ revealed` (33 bytes). */
const STATE_LEN = 33;

/**
 * The new device's side.
 *
 * 1. `create` draws `r_N`. Persist {@link JoinerApproval.secretState} with the device
 *    secrets (the key store), because approval may come after a restart.
 * 2. Enrol with `commitment()` in `device-enrol` key 7 (or, for a retry, in an
 *    `approval-request {device, sas_commit}` policy op, after {@link renew}). Then
 *    check the log: {@link verifyOwnEnrol} checks the keys, and
 *    {@link verifyOwnCommitment} checks the **latest** commitment for this device.
 *    If the control plane appended a commitment of its own, the check fails, the
 *    device shows no code, and the approval fails.
 * 3. On the **first** challenge (`r_A` from approver `A`, whose keys come from this
 *    device's log view), {@link onChallenge} marks `r_N` revealed, persists that,
 *    and only then returns `r_N` and the code to show.
 * 4. **`r_N` is revealed at most once.** A later challenge is refused with
 *    `already_revealed`. Once `r_N` is public, a relayed challenge could be ground
 *    to make this device's code match the one an approver shows for an attacker's
 *    device. A retry needs {@link renew} and a new `approval-request`.
 * 5. {@link acceptsGrantFrom} says whether a `key_grant` may be used. Only one
 *    signed by the device this one compared codes with may (§5.3 step 6).
 */
export class JoinerApproval {
  private approver: string | null = null;
  private keysChecked = false;
  private commitChecked = false;

  private constructor(
    readonly collection: string,
    readonly own: EnrolledKeys,
    private readonly rN: Uint8Array,
    private revealed: boolean,
  ) {}

  /** A fresh approval state with a new `r_N` from the CSPRNG. */
  static create(collection: string, own: EnrolledKeys): JoinerApproval {
    return new JoinerApproval(collection, own, crypto.getRandomValues(new Uint8Array(32)), false);
  }

  /** Restore from {@link secretState} after a restart. */
  static restore(collection: string, own: EnrolledKeys, state: Uint8Array): JoinerApproval {
    if (state.length !== STATE_LEN || (state[32] !== 0 && state[32] !== 1)) throw new ApprovalError("bad_length", "joiner state is 33 bytes");
    return new JoinerApproval(collection, own, state.slice(0, 32), state[32] === 1);
  }

  /**
   * `r_N ‖ revealed`. Secret until revealed. Store it with the device secrets,
   * never in the vault.
   */
  get secretState(): Uint8Array {
    const s = new Uint8Array(STATE_LEN);
    s.set(this.rN);
    s[32] = this.revealed ? 1 : 0;
    return s;
  }

  /** `r_N` was already revealed: a retry needs {@link renew}. */
  get isRevealed(): boolean {
    return this.revealed;
  }

  /**
   * A fresh `r_N` for a retry (after a reveal, a failed or abandoned approval, or a
   * restart that lost the state). Append its `commitment()` as
   * `approval-request {device, sas_commit}` and verify it as in step 2.
   */
  renew(): JoinerApproval {
    this.rN.fill(0);
    return JoinerApproval.create(this.collection, this.own);
  }

  /** The commitment for `device-enrol` key 7 or `approval-request`. */
  commitment(): Promise<Uint8Array> {
    return sasCommit(this.collection, this.own, this.rN);
  }

  /** Step 2: the enrol item in the log carries exactly our keys (and, at first enrolment, our commitment). */
  async verifyOwnEnrol(item: EnrolledKeys): Promise<void> {
    const ok =
      item.device === this.own.device &&
      bytesEqual(item.signPk, this.own.signPk) &&
      bytesEqual(item.kemPk, this.own.kemPk) &&
      bytesEqual(item.noisePk, this.own.noisePk);
    if (!ok) throw new ApprovalError("enrol_mismatch", "the enrol item in the log does not carry this device's keys");
    this.keysChecked = true;
    if (item.sasCommit) await this.verifyOwnCommitment(item.device, item.sasCommit);
  }

  /**
   * Step 2: `latest` is this device's current commitment in the log (the enrol
   * item's key 7, or the latest `approval-request`). It must be ours.
   */
  async verifyOwnCommitment(device: string, latest: Uint8Array): Promise<void> {
    this.commitChecked = false;
    if (device !== this.own.device || !bytesEqual(latest, await this.commitment())) {
      throw new ApprovalError("enrol_mismatch", "the latest commitment in the log for this device is not this device's");
    }
    this.commitChecked = true;
  }

  /**
   * The first challenge, from `approver` (keys from our own log view). Marks `r_N`
   * revealed and awaits `persist(secretState)` **before** returning what to reveal,
   * so a crash can't lead to revealing twice.
   */
  async onChallenge(
    approver: { device: string; signPk: Uint8Array },
    rA: Uint8Array,
    persist: (state: Uint8Array) => Promise<void>,
  ): Promise<{ reveal: Uint8Array; sas: string }> {
    if (!this.keysChecked || !this.commitChecked) throw new ApprovalError("wrong_state", "verify the enrol item and commitment before answering a challenge");
    if (this.revealed) throw new ApprovalError("already_revealed", "r_N was already revealed; renew and send an approval-request to retry");
    const sas = await sasCode(this.collection, approver, this.own, rA, this.rN);
    this.revealed = true;
    await persist(this.secretState);
    this.approver = approver.device;
    return { reveal: this.rN.slice(), sas };
  }

  /** §5.3 step 6: use a `key_grant` only from the device whose code the user compared. */
  acceptsGrantFrom(signer: string): boolean {
    return this.approver !== null && signer === this.approver;
  }

  /** Forget `r_N` once keyed. */
  wipe(): void {
    this.rN.fill(0);
  }
}

/** Outcome of {@link ApproverApproval.confirm}. */
export type ConfirmResult = "approved" | "mismatch";

/**
 * The approving device's side, for one enrolled device `N`.
 *
 * 1. Construct with `N`'s enrol item **from this device's log view**, with `sasCommit`
 *    set to `N`'s **latest** commitment (enrol key 7, or the latest
 *    `approval-request`). A new commitment means a new `ApproverApproval`.
 * 2. {@link challenge} draws `r_A`, which is sent to `N` (`start_approval`).
 * 3. {@link onReveal} checks `r_N` against the commitment and yields the code.
 * 4. {@link confirm} with the code the user read off `N`. After
 *    {@link MAX_ATTEMPTS} mismatches it locks; `N` must send a fresh
 *    `approval-request`.
 *
 * One challenge per commitment: `N` answers only the first, so a second
 * {@link challenge} on the same commitment is refused here too.
 *    `approved` means: append the `key_grant` for `N`.
 */
export class ApproverApproval {
  private rA: Uint8Array | null = null;
  private sas: string | null = null;
  private failures = 0;
  private challenged = false;

  constructor(
    readonly collection: string,
    readonly self: { device: string; signPk: Uint8Array },
    readonly joiner: EnrolledKeys,
  ) {
    if (!joiner.sasCommit) throw new ApprovalError("no_commitment", "the device enrolled without a SAS commitment and can't be approved");
  }

  /** Draw `r_A`. Only now, after `N`'s commitment is in our view (step 2). */
  challenge(): Uint8Array {
    if (this.failures >= MAX_ATTEMPTS) throw new ApprovalError("too_many_attempts");
    if (this.challenged) throw new ApprovalError("already_revealed", "this commitment was already challenged; wait for a new approval-request");
    this.challenged = true;
    this.rA = crypto.getRandomValues(new Uint8Array(32));
    this.sas = null;
    return this.rA.slice();
  }

  /** `N` revealed `r_N`: check the commitment, compute the code. */
  async onReveal(rN: Uint8Array): Promise<string> {
    if (!this.rA) throw new ApprovalError("wrong_state", "no challenge outstanding");
    const c = await sasCommit(this.collection, this.joiner, rN);
    if (!bytesEqual(c, this.joiner.sasCommit!)) {
      this.rA = null;
      throw new ApprovalError("commitment_mismatch", "the new device's revealed value doesn't match its commitment");
    }
    this.sas = await sasCode(this.collection, this.self, this.joiner, this.rA, rN);
    return this.sas;
  }

  /** The code to display, once revealed. */
  get code(): string | null {
    return this.sas;
  }

  /** Remaining confirmation attempts. */
  get attemptsLeft(): number {
    return MAX_ATTEMPTS - this.failures;
  }

  /** The user typed the code shown on `N`. */
  confirm(typed: string): ConfirmResult {
    if (this.failures >= MAX_ATTEMPTS) throw new ApprovalError("too_many_attempts");
    if (!this.sas) throw new ApprovalError("wrong_state", "no code yet");
    if (sasEqual(typed, this.sas)) return "approved";
    this.failures++;
    if (this.failures >= MAX_ATTEMPTS) {
      this.rA = null;
      this.sas = null;
    }
    return "mismatch";
  }
}
