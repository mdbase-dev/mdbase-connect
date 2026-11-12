/**
 * Settling a write: one answer to "was it saved, and how does the record read
 * now?". A write is identified by its mutation ID from before it is submitted,
 * so every path here observes that one mutation and nothing is ever resubmitted.
 */
import { isMdbaseError, MdbaseError } from "./errors.js";
import type { MdbaseClient, RecordRef, Write } from "./client.js";
import type { ContractRecordView, ContractSelector } from "./contract-records.js";
import type { Conflict, Receipt, RecordView } from "./plain.js";
import type { Include, Problem, Uuid } from "./wire.js";

/** Which record to read back once the write is kept, and how. */
export interface SettleRead {
  /** Default: the record the write targets (`write.recordId`), or the one
   * record its receipt names. Needed when settling a bare mutation ID whose
   * receipt names no record. */
  record?: RecordRef;
  include?: Include;
  /** Also read the record through this contract (`contractRecord`). */
  contract?: ContractSelector;
}

export interface SettleOptions {
  /** How long to wait for the sync service to confirm. Still waiting then is
   * `saved_on_device`, not a failure. Default 3 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Read the record back as it now reads here. `true` reads it with defaults. */
  read?: boolean | SettleRead;
}

interface Kept {
  readonly mutationId: Uuid;
  readonly receipt: Receipt;
  /** With `read`: the record as it now reads here, or `null` when it no longer
   * exists (a delete, or deleted since). Absent when `read` was not asked for. */
  readonly record?: RecordView | null;
  /** With `read.contract`: the same record through that contract. */
  readonly contractRecord?: ContractRecordView | null;
}

/**
 * How a write ended.
 *
 * - `confirmed`: the sync service has it.
 * - `saved_on_device`: kept on this device; it syncs when the service can be
 *   reached, and `client.ledger` shows how that ends.
 * - `conflicted`: confirmed, but a concurrent change won for some values;
 *   `conflicts` says what the record kept and what this write lost.
 * - `rejected`: not saved, and `problem` says why. Without a `receipt` the
 *   replica refused it when it was submitted; without a `mutationId` it was
 *   refused before anything was sent.
 * - `unknown`: it may have been saved. Keep `mutationId` and call
 *   `settle(mutationId)` again later; never submit the write again.
 */
export type Settlement =
  | (Kept & { readonly outcome: "confirmed" | "saved_on_device" })
  | (Kept & { readonly outcome: "conflicted"; readonly conflicts: readonly Conflict[] })
  | { readonly outcome: "rejected"; readonly mutationId?: Uuid; readonly receipt?: Receipt; readonly problem: Problem }
  | { readonly outcome: "unknown"; readonly mutationId: Uuid; readonly receipt?: Receipt; readonly problem: Problem };

type SettleClient = Pick<MdbaseClient, "receipt" | "awaitReceipt" | "get" | "getContract">;

const DEFAULT_WAIT_MS = 3_000;
const cancelled = (e: unknown): boolean => isMdbaseError(e, "cancelled");
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function unknown(mutationId: Uuid, reason: string, text: string, receipt?: Receipt): Settlement {
  const problem: Problem = { code: "outcome_unknown", recovery: "resolve_outcome", reason, message: text };
  return Object.freeze({ outcome: "unknown" as const, mutationId, ...(receipt ? { receipt } : {}), problem });
}

/** @internal `MdbaseClient.settle`. */
export async function settleWrite(
  client: SettleClient,
  input: Write | Promise<Write> | Uuid,
  options: SettleOptions = {},
): Promise<Settlement> {
  const signal = options.signal;
  let write: Write | undefined;
  let mutationId: Uuid;
  let receipt: Receipt;

  if (typeof input === "string") {
    mutationId = input;
    try {
      receipt = await client.receipt(mutationId, signal);
    } catch (e) {
      if (cancelled(e)) throw e;
      // No receipt for an ID means the replica never captured that write.
      if (isMdbaseError(e, "not_found")) return Object.freeze({ outcome: "rejected" as const, mutationId, problem: e.toProblem() });
      return unknown(mutationId, "receipt_unavailable", `The write's result could not be read: ${message(e)}`);
    }
  } else {
    try {
      write = await input;
      mutationId = write.mutationId;
      receipt = write.receipt;
    } catch (e) {
      // One mutation is settled here; a partial batch names several.
      if (!(e instanceof MdbaseError) || cancelled(e) || (e.mutationIds && e.mutationIds.length > 1)) throw e;
      if (e.mutationId === undefined) return Object.freeze({ outcome: "rejected" as const, problem: e.toProblem() });
      mutationId = e.mutationId;
      // An error from submit does not prove the write was not captured: only
      // its receipt does.
      try {
        receipt = await client.receipt(mutationId, signal);
      } catch (lookup) {
        if (cancelled(lookup)) throw lookup;
        if (isMdbaseError(lookup, "not_found")) return Object.freeze({ outcome: "rejected" as const, mutationId, problem: e.toProblem() });
        return unknown(mutationId, "receipt_unavailable", `The write may have been saved: ${e.message}`);
      }
    }
  }

  if (receipt.state === "pending") {
    try {
      receipt = await client.awaitReceipt(mutationId, options.timeoutMs ?? DEFAULT_WAIT_MS, signal);
      write?.update(receipt);
    } catch (e) {
      if (cancelled(e)) throw e;
      // The wait failing says nothing about the write: it is on this device.
      receipt = write?.receipt ?? receipt;
    }
  }
  if (receipt.mutation !== mutationId) {
    throw new MdbaseError(
      { code: "internal", recovery: "contact_support", message: "the replica answered with another mutation's receipt" },
      { mutationId },
    );
  }

  if (receipt.state === "unknown") {
    const problem = receipt.problem ?? { code: "outcome_unknown", recovery: "resolve_outcome" as const, message: "The write's result is not known." };
    return Object.freeze({ outcome: "unknown" as const, mutationId, receipt, problem });
  }
  if (receipt.state === "rejected") {
    const problem = receipt.problem ?? { code: "internal", recovery: "contact_support" as const, message: "The write was rejected without a reason." };
    return Object.freeze({ outcome: "rejected" as const, mutationId, receipt, problem });
  }

  let read: { record: RecordView | null; contractRecord?: ContractRecordView | null } | undefined;
  if (options.read) {
    const how = options.read === true ? {} : options.read;
    const named = receipt.records?.length === 1 ? receipt.records[0]!.id : undefined;
    const ref = how.record ?? write?.recordId ?? named;
    if (ref === undefined) {
      throw new MdbaseError(
        { code: "invalid_request", recovery: "fix_request", message: "settle cannot tell which record to read back; pass read.record" },
        { mutationId },
      );
    }
    try {
      read = await readBack(client, ref, how, signal);
    } catch (e) {
      if (cancelled(e)) throw e;
      return unknown(mutationId, "readback_failed", `The write was kept, but the record could not be read back: ${message(e)}`, receipt);
    }
  }

  const kept = { mutationId, receipt, ...read };
  if (receipt.state === "pending") return Object.freeze({ outcome: "saved_on_device" as const, ...kept });
  if (receipt.status === "conflicted") return Object.freeze({ outcome: "conflicted" as const, ...kept, conflicts: Object.freeze([...(receipt.conflicts ?? [])]) });
  return Object.freeze({ outcome: "confirmed" as const, ...kept });
}

async function readBack(
  client: SettleClient,
  ref: RecordRef,
  how: SettleRead,
  signal: AbortSignal | undefined,
): Promise<{ record: RecordView | null; contractRecord?: ContractRecordView | null }> {
  let record: RecordView;
  try {
    record = await client.get(ref, how.include, signal);
  } catch (e) {
    if (!isMdbaseError(e, "not_found")) throw e;
    return how.contract ? { record: null, contractRecord: null } : { record: null };
  }
  return how.contract ? { record, contractRecord: await client.getContract(record, how.contract, signal) } : { record };
}
