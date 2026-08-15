import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

const LOCAL_CONTROL_PROTOCOL_VERSION = 4;
const MAX_LOCAL_CONTROL_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ControlResponse<T = unknown> {
  id: string;
  protocol_version: number;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class AgentControlError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AgentControlError";
  }
}

export function requestAgent<T>(
  endpoint: string,
  method: string,
  params?: unknown,
  timeoutMs = 5_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const requestId = randomUUID();
    let received = "";
    let receivedBytes = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("The local connector did not respond in time."));
    }, timeoutMs);

    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        id: requestId,
        protocol_version: LOCAL_CONTROL_PROTOCOL_VERSION,
        method,
        ...(params === undefined ? {} : { params })
      })}\n`);
    });
    socket.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk, "utf8");
      if (receivedBytes > MAX_LOCAL_CONTROL_RESPONSE_BYTES) {
        finish(new AgentControlError(
          "local_response_too_large",
          "The connector returned an oversized local response."
        ));
        return;
      }
      received += chunk;
      const newline = received.indexOf("\n");
      if (newline === -1) return;
      try {
        const response = JSON.parse(received.slice(0, newline)) as ControlResponse<T>;
        clearTimeout(timer);
        socket.end();
        if (response.id !== requestId) {
          reject(new AgentControlError(
            "invalid_local_response",
            "The connector returned a response for a different request."
          ));
          return;
        }
        if (response.protocol_version !== LOCAL_CONTROL_PROTOCOL_VERSION) {
          reject(new AgentControlError(
            "unsupported_local_protocol",
            `The connector uses local protocol ${response.protocol_version}; expected ${LOCAL_CONTROL_PROTOCOL_VERSION}.`
          ));
          return;
        }
        if (!response.ok) {
          reject(new AgentControlError(
            response.error?.code ?? "agent_request_failed",
            response.error?.message ?? "The local connector rejected the request."
          ));
          return;
        }
        resolve(response.result as T);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}
