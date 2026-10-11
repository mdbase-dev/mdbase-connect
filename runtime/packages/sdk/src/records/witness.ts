import { decode, encode } from "../cbor.js";
import { MdbaseError, mdbaseError } from "../errors.js";
import { revisionOf } from "../values.js";
import { recordView, type Problem, type RecordView } from "../wire.js";
export const include = { body: true, document: true, effective: true };
export const MAX_BYTES = 8 * 1024 * 1024;
export function complete(record: RecordView, id?: string): void {
    if (
        (record.document?.length ?? 0) > MAX_BYTES ||
        (record.body?.length ?? 0) > MAX_BYTES
    )
        throw mdbaseError(
            "invalid_request",
            "native record exceeds the record session source budget",
            "record_session_budget",
        );
    if (
        (id !== undefined && record.id !== id) ||
        typeof record.document !== "string" ||
        typeof record.body !== "string" ||
        revisionOf(record.document) !== record.revision
    ) {
        throw mdbaseError(
            "invalid_request",
            "record session needs actual complete, revision-consistent source and identity",
            "record_witness_required",
        );
    }
}
export function protectedRecord(record: RecordView): boolean {
    return (
        record.state.hold !== undefined ||
        (record.state.unresolved !== undefined && record.state.unresolved !== 0)
    );
}
export function confirmed(record: RecordView): boolean {
    return record.state.state === "confirmed" && !protectedRecord(record);
}
/** Clone native data, never reconstruct source or invent confirmed metadata. */
export function copy(record: RecordView): RecordView {
    return recordView.dec(decode(encode(recordView.enc(record))));
}
export function problem(error: unknown): Problem {
    if (error instanceof MdbaseError) return error.toProblem();
    if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
    )
        return mdbaseError("cancelled", error.message).toProblem();
    return mdbaseError(
        "internal",
        error instanceof Error ? error.message : "record session failure",
    ).toProblem();
}
export function refusal(
    code: "conflict" | "outcome_unknown" | "unavailable" | "cancelled",
    message: string,
    reason: string,
): MdbaseError {
    return new MdbaseError({
        code,
        message,
        reason,
        recovery:
            code === "conflict"
                ? "resolve_conflict"
                : code === "outcome_unknown"
                  ? "resolve_outcome"
                  : "retry",
    });
}
/** Serialized retained-data accounting, not a measured heap/custody claim. */
export function recordBytes(record: RecordView): number {
    return encode(recordView.enc(record)).byteLength * 2;
}
export function textBytes(text: string): number {
    if (text.length > MAX_BYTES)
        throw mdbaseError(
            "invalid_request",
            "record session draft exceeds retained budget",
            "record_session_budget",
        );
    return new TextEncoder().encode(text).byteLength * 2;
}
export function timeout(value: number | undefined): number {
    const n = value ?? 30_000;
    if (!Number.isSafeInteger(n) || n < 1 || n > 120_000)
        throw mdbaseError(
            "invalid_request",
            "record session timeout must be 1..120000ms",
            "invalid_timeout",
        );
    return n;
}
