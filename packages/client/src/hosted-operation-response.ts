import { connectError, serverConnectError, type MdbaseConnectError } from "./errors.js";
import { decodeJsonResponse } from "./runtime-utils.js";

export async function decodeHostedOperationResponse(
  response: Response,
  hosted: boolean
): Promise<{ body: any; httpError?: MdbaseConnectError }> {
  try {
    return {
      body: await decodeJsonResponse(
        response,
        "invalid_operation_response",
        "The collection authority returned a response that is not valid JSON."
      )
    };
  } catch (cause) {
    if (!response.ok && hosted && isDefinitiveHostedHttpRejection(response.status)) {
      return {
        body: undefined,
        httpError: serverConnectError("operation_failed", "Collection operation failed.", {
          status: response.status,
          operationOutcome: "rejected"
        })
      };
    }
    throw connectError(
      "invalid_operation_response",
      "The collection authority returned a response that is not valid JSON.",
      { cause }
    );
  }
}

function isDefinitiveHostedHttpRejection(status: number): boolean {
  return status >= 400
    && status < 500
    && ![408, 425, 429].includes(status);
}
