import {
    list,
    struct,
    uuid,
    hash,
    tstr,
    value,
    SchemaError,
    type Codec,
} from "./codec.js";
import { encode, type CborValue } from "./cbor.js";
import { type Issue, severity } from "./wire.js";
import type { RecordRef } from "./client.js";
import { mdbaseError } from "./errors.js";

/** A real Core diagnostic of a current persisted/local-native record. */
export interface ValidationIssue extends Issue {
    location?: string;
    typeName?: string;
    tier: "request" | "single_record" | "cross_record";
}
export interface RecordValidation {
    id: string;
    issues: ValidationIssue[];
    path: string;
    /** Actual full native document SHA, never an unsaved-draft/write authorization. */
    revision: string;
}
function parseTier(input: unknown): ValidationIssue["tier"] {
    if (
        input === "request" ||
        input === "single_record" ||
        input === "cross_record"
    )
        return input;
    throw new SchemaError("validation-tier", "unknown diagnostic tier", true);
}
const tier: Codec<ValidationIssue["tier"]> = {
    name: "validation-tier",
    enc: parseTier,
    dec: parseTier,
};
const validationIssue = struct<ValidationIssue>("validation-issue", [
    [0, "code", tstr],
    [1, "severity", severity],
    [2, "message", tstr],
    [3, "details", value, "opt"],
    [4, "location", tstr, "opt"],
    [5, "typeName", tstr, "opt"],
    [6, "tier", tier],
]);
const row = struct<RecordValidation>("record-validation", [
    [0, "id", uuid],
    [1, "issues", list(validationIssue)],
    [2, "path", tstr],
    [3, "revision", hash],
]);
const rows = list(row);
const invalid = (message: string) =>
    new SchemaError("record-validations", message);
/** Bounded strict decoding, never default missing diagnostics/current witnesses. */
export const recordValidations: Codec<RecordValidation[]> = {
    name: "record-validations",
    enc: (v) => rows.enc(v),
    dec: (v) => {
        if (!Array.isArray(v) || v.length > 1000)
            throw invalid("invalid inventory");
        let issues = 0,
            nodes = 0;
        const stack: [CborValue, number][] = [[v, 0]];
        while (stack.length) {
            const [item, depth] = stack.pop()!;
            if (++nodes > 65536 || depth > 32)
                throw invalid("result exceeds tree bounds");
            if (Array.isArray(item)) {
                if (item.length > 65536) throw invalid("oversized array");
                for (const child of item) stack.push([child, depth + 1]);
            } else if (item instanceof Map) {
                if (item.size > 32768) throw invalid("oversized map");
                for (const [k, child] of item) {
                    stack.push([k, depth + 1], [child, depth + 1]);
                }
            }
        }
        for (const r of v) {
            const diagnostics =
                r instanceof Map
                    ? (r as Map<number, CborValue>).get(1)
                    : undefined;
            if (!Array.isArray(diagnostics))
                throw invalid("missing diagnostics");
            issues += diagnostics.length;
            if (issues > 4096) throw invalid("too many diagnostics");
        }
        if (encode(v).byteLength > 1024 * 1024)
            throw invalid("result exceeds byte bounds");
        const out = rows.dec(v);
        for (const r of out) {
            if (!r.path || new TextEncoder().encode(r.path).byteLength > 4096)
                throw invalid("invalid current path");
        }
        return out;
    },
};
interface Expected {
    id?: string;
    revision?: string;
}
/** Capture both protocol selection and revision expectation in one pass. */
export function captureValidation(refs: readonly RecordRef[] | undefined): {
    targets: CborValue[] | undefined;
    expected: Expected[] | undefined;
} {
    if (refs === undefined) return { targets: undefined, expected: undefined };
    if (!Array.isArray(refs) || refs.length > 1000)
        throw mdbaseError(
            "invalid_request",
            "At most 1000 validation selections are allowed.",
            "validation_bounds",
        );
    const targets: CborValue[] = [],
        expected: Expected[] = [];
    for (const ref of Array.from(refs)) {
        if (typeof ref === "string") {
            const id = uuid.dec(uuid.enc(ref));
            targets.push(uuid.enc(id));
            expected.push({ id });
            continue;
        }
        if (!ref || typeof ref !== "object")
            throw mdbaseError(
                "invalid_request",
                "Validation needs UUID, path or record selections.",
                "validation_selection",
            );
        if ("id" in ref) {
            const id = uuid.dec(uuid.enc(ref.id)),
                revision = hash.dec(hash.enc(ref.revision));
            targets.push(uuid.enc(id));
            expected.push({ id, revision });
            continue;
        }
        const path = ref.path;
        if (
            typeof path !== "string" ||
            !path ||
            path.length > 4096 ||
            new TextEncoder().encode(path).byteLength > 4096
        )
            throw mdbaseError(
                "invalid_request",
                "Validation paths must be nonempty and at most 4096 UTF-8 bytes.",
                "validation_selection",
            );
        targets.push(path);
        expected.push({});
    }
    return { targets, expected };
}
export function bindValidation(
    result: RecordValidation[],
    expected: Expected[] | undefined,
): RecordValidation[] {
    if (
        expected &&
        (result.length !== expected.length ||
            result.some(
                (r, i) =>
                    expected[i]?.id !== undefined && expected[i]!.id !== r.id,
            ))
    )
        throw mdbaseError(
            "internal",
            "Validation did not return the complete selected record identities.",
            "invalid_validation_result",
        );
    if (
        expected &&
        result.some(
            (r, i) =>
                expected[i]?.revision !== undefined &&
                expected[i]!.revision !== r.revision,
        )
    )
        throw mdbaseError(
            "unavailable",
            "The validated document differs from the selected record revision.",
            "record_validation_stale",
        );
    return result;
}
