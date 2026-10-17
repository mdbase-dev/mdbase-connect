/** Bounded authenticated operator intent, never an outcome/ACK/proof input. */
import { boundedText, serviceAuthorization } from "./service-devices.ts";

export type MigrationOperatorRequest = {
  collection: string; operation: "rollback" | "restart" | "resume" | "resolve" | "abandon"; expectedSequence: number;
};
export async function migrationOperatorRequest(request: Request, token?: string): Promise<MigrationOperatorRequest | Response> {
  const denied = serviceAuthorization(request, token);
  if (denied) return denied;
  const invalid = () => Response.json({ error: "invalid_request" }, { status: 400, headers: { "cache-control": "no-store" } });
  const text = await boundedText(request, 1024);
  try {
    const b = text === null ? null : JSON.parse(text) as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.collection !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.collection) || b.collection === "00000000-0000-0000-0000-000000000000") return invalid();
    if (!["rollback", "restart", "resume", "resolve", "abandon"].includes(b.operation as string)) return invalid();
    const sequenceKey = b.operation === "rollback" || b.operation === "restart" || b.operation === "resume" ? "expected_run_sequence" : "expected_action_sequence";
    if (Object.keys(b).length !== 3 || !Number.isSafeInteger(b[sequenceKey]) || (b[sequenceKey] as number) <= 0) return invalid();
    return { collection: b.collection, operation: b.operation as MigrationOperatorRequest["operation"], expectedSequence: b[sequenceKey] as number };
  } catch { return invalid(); }
}
export function migrationOperatorBody(input: MigrationOperatorRequest) {
  return { collection: input.collection, operation: input.operation,
    [input.operation === "rollback" || input.operation === "restart" || input.operation === "resume" ? "expected_run_sequence" : "expected_action_sequence"]: input.expectedSequence };
}
