import type { FileTransferSession } from "@mdbase-dev/connect-protocol";
import type { GrantKeyStore } from "./crypto.js";
import { connectError } from "./errors.js";
import {
  performHostedFilePartRequest,
  performHostedFileRequest
} from "./hosted-file-request.js";
import type { StoredToken } from "./internal-types.js";
import { LocalFileTransport } from "./local-file-transport.js";

type ProofHeaders = (
  token: StoredToken,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body: string | undefined,
  credential: string
) => Promise<Record<string, string>>;

export interface ConnectionFileTransportOptions {
  keyStore: GrantKeyStore;
  serverUrl: string;
  loopbackUrl: string;
  authorizedToken(signal?: AbortSignal): Promise<StoredToken | null>;
  refreshAuthorization(signal?: AbortSignal): Promise<StoredToken>;
  shouldAttemptDirect(token: StoredToken): Promise<boolean>;
  onDirectAvailable(): void;
  onDirectUnavailable(): void;
  onRelayAvailable(): void;
  authorityProofHeaders: ProofHeaders;
}

/**
 * Owns every transport concern specific to files. ConnectionTransport only
 * supplies authorization, routing, and proof-signing policy.
 */
export class ConnectionFileTransport {
  private readonly local: LocalFileTransport;

  constructor(private readonly options: ConnectionFileTransportOptions) {
    this.local = new LocalFileTransport(options);
  }

  async control<Result>(
    method: "GET" | "POST" | "DELETE",
    path = "",
    input?: unknown,
    signal?: AbortSignal
  ): Promise<Result> {
    const token = await this.requireFileToken(signal);
    if (!token.authority) {
      return this.local.control<Result>(token, method, path, input, signal);
    }
    return performHostedFileRequest<Result>(
      token,
      method,
      path,
      input,
      signal,
      this.options.refreshAuthorization,
      this.options.authorityProofHeaders
    );
  }

  uploadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    return this.local.uploadChunk(session, chunkIndex, bytes, signal);
  }

  downloadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    return this.local.downloadChunk(session, chunkIndex, signal);
  }

  async downloadHostedPart(
    session: FileTransferSession,
    partIndex: number,
    expectedLength: number,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    const token = await this.requireFileToken(signal);
    if (!token.authority) {
      throw connectError(
        "not_remote_authority",
        "Hosted file delivery requires a remote authority endpoint."
      );
    }
    return performHostedFilePartRequest(
      token,
      `downloads/${encodeURIComponent(session.transfer_id)}/parts/${partIndex}`,
      expectedLength,
      signal,
      this.options.refreshAuthorization,
      this.options.authorityProofHeaders
    );
  }

  private async requireFileToken(signal?: AbortSignal): Promise<StoredToken> {
    const token = await this.options.authorizedToken(signal);
    if (!token?.fileCapability) {
      throw connectError("not_authorized", "This connection has no file capability.");
    }
    return token;
  }
}
