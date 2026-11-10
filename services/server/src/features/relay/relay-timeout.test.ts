import { describe, expect, it } from "vitest";
import type { EncryptedRelayEnvelope } from "@mdbase-dev/connect-protocol";
import { relayExecutionTimeoutProblem } from "./relay.js";

const requestId = "66666666-6666-4666-8666-666666666666";

describe("relay execution timeout semantics", () => {
  it.each(["create", "sync", "file_control"] as const)(
    "reports an admitted encrypted %s as outcome unknown",
    (operation) => {
      expect(relayExecutionTimeoutProblem(envelope(operation), requestId)).toMatchObject({
        code: "operation_outcome_unknown",
        operation_outcome: "unknown",
        details: { request_id: requestId }
      });
    }
  );

  it("keeps reads retryable with a not-sent outcome", () => {
    expect(relayExecutionTimeoutProblem(envelope("query"), requestId)).toMatchObject({
      code: "operation_cancelled",
      operation_outcome: "not_sent"
    });
  });
});

function envelope(operation: EncryptedRelayEnvelope["operation"]): EncryptedRelayEnvelope {
  return {
    type: "encrypted_operation_request",
    protocol_version: 3,
    suite: "P256-HKDF-SHA256-AES256GCM",
    request_id: requestId,
    grant_id: "11111111-1111-4111-8111-111111111111",
    application_id: "22222222-2222-4222-8222-222222222222",
    connector_id: "33333333-3333-4333-8333-333333333333",
    collection_id: "44444444-4444-4444-8444-444444444444",
    operation,
    scope_epoch: 1,
    key_id: "test-key",
    counter: "1",
    ciphertext: "b3BhcXVl"
  };
}
