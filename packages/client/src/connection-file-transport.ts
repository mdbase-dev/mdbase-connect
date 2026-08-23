import type { FileTransferSession } from "@mdbase-dev/connect-protocol";
import type { GrantKeyStore } from "./crypto.js";
import { connectError } from "./errors.js";
import {
  performHostedFilePartRequest,
  performHostedFileRequest
} from "./hosted-file-request.js";
import type { StoredToken } from "./internal-types.js";
import { GrantKeyLeaseSet, retainCurrentGrantToken } from "./grant-key-leases.js";
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
  collectionId: string;
  currentToken(): StoredToken | null;
  authorizedToken(signal?: AbortSignal): Promise<StoredToken | null>;
  refreshAuthorization(signal?: AbortSignal): Promise<StoredToken>;
  shouldAttemptDirect(token: StoredToken): Promise<boolean>;
  onDirectAvailable(): void;
  onDirectUnavailable(): void;
  onRelayAvailable(): void;
  authorityProofHeaders: ProofHeaders;
  acquireGrantKeyLease(
    collectionId: string,
    keyHandle: string,
    signal?: AbortSignal
  ): Promise<() => void>;
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
    const leased = await this.requireFileToken(signal);
    const token = leased.token;
    try {
      if (!token.authority) {
        return await this.local.control<Result>(token, method, path, input, signal);
      }
      return await performHostedFileRequest<Result>(
        token,
        method,
        path,
        input,
        signal,
        this.options.refreshAuthorization,
        this.options.authorityProofHeaders,
        leased.retain
      );
    } finally {
      leased.release();
    }
  }

  async uploadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const leased = await this.requireFileToken(signal);
    try {
      return await this.local.uploadChunk(session, chunkIndex, bytes, signal, leased.token);
    } finally {
      leased.release();
    }
  }

  async downloadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const leased = await this.requireFileToken(signal);
    try {
      return await this.local.downloadChunk(session, chunkIndex, signal, leased.token);
    } finally {
      leased.release();
    }
  }

  async downloadHostedPart(
    session: FileTransferSession,
    partIndex: number,
    expectedLength: number,
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    const leased = await this.requireFileToken(signal);
    const token = leased.token;
    try {
      if (!token.authority) {
        throw connectError(
          "not_remote_authority",
          "Hosted file delivery requires a remote authority endpoint."
        );
      }
      return await performHostedFilePartRequest(
        token,
        `downloads/${encodeURIComponent(session.transfer_id)}/parts/${partIndex}`,
        expectedLength,
        signal,
        this.options.refreshAuthorization,
        this.options.authorityProofHeaders,
        leased.retain
      );
    } finally {
      leased.release();
    }
  }

  private async requireFileToken(signal?: AbortSignal) {
    const leases = new GrantKeyLeaseSet(
      this.options.collectionId,
      this.options.acquireGrantKeyLease
    );
    try {
      await retainCurrentGrantToken(this.options.currentToken, leases, signal);
      await this.options.authorizedToken(signal);
      const token = await retainCurrentGrantToken(this.options.currentToken, leases, signal);
      if (!token?.fileCapability) {
        throw connectError("not_authorized", "This connection has no file capability.");
      }
      return {
        token,
        retain: async (_refreshed: StoredToken) => {
          const current = await retainCurrentGrantToken(this.options.currentToken, leases, signal);
          if (current) return current;
          throw connectError("not_authorized", "Reconnect this application to continue.");
        },
        release: () => leases.release()
      };
    } catch (error) {
      leases.release();
      throw error;
    }
  }
}
