import type {
  ConnectProblem,
  EncryptedRelayOperationResponse,
  FileFrameHeader,
  FileTransferSession
} from "@mdbase/connect-protocol";
import {
  decodeFileFrame,
  FILE_PROTOCOL_VERSION,
  FILE_TRANSFER_PROTOCOL_VERSION
} from "@mdbase/connect-protocol";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  type GrantKeyStore
} from "./crypto.js";
import {
  MdbaseConnectError,
  connectError,
  serverConnectError
} from "./errors.js";
import { GrantFileTransferCipher } from "./file-crypto.js";
import type { StoredToken } from "./internal-types.js";
import { loopbackRequest } from "./operation-helpers.js";
import { apiError } from "./runtime-utils.js";

interface LocalFileTransportOptions {
  keyStore: GrantKeyStore;
  loopbackUrl: string;
  authorizedToken(): Promise<StoredToken | null>;
  shouldAttemptDirect(token: StoredToken): Promise<boolean>;
  onDirectAvailable(): void;
}

/** Keeps grant-bound file crypto and loopback framing out of the operation transport. */
export class LocalFileTransport {
  constructor(private readonly options: LocalFileTransportOptions) {}

  async control<Result>(
    token: StoredToken,
    method: "GET" | "POST" | "DELETE",
    path: string,
    input: unknown,
    signal?: AbortSignal
  ): Promise<Result> {
    requireEncryption(token);
    await this.requireDirect(token, "control");
    const encryptedRequest = await encryptRelayRequest(
      this.options.keyStore,
      token.keyHandle!,
      relayBinding(token),
      "file_control",
      localFileControlInput(method, path, input)
    );
    const response = await fetch(
      `${this.options.loopbackUrl}/v1/files/control`,
      loopbackRequest({
        method: "POST",
        headers: { "content-type": "application/mdbase-connect+json" },
        body: JSON.stringify(encryptedRequest),
        signal
      })
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw apiError(body, "operation_failed", "Collection file request failed.", response.status);
    }
    const encryptedResponse = body?.envelope as EncryptedRelayOperationResponse | undefined;
    if (!encryptedResponse) {
      throw connectError(
        "invalid_encrypted_response",
        "The connector omitted its encrypted file response."
      );
    }
    const decrypted = await decryptRelayResponse<Result>(
      this.options.keyStore,
      token.keyHandle!,
      relayBinding(token),
      encryptedRequest,
      encryptedResponse
    );
    if (!decrypted.ok) throwEncryptedProblem(decrypted.problem);
    this.options.onDirectAvailable();
    return decrypted.result;
  }

  async uploadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const token = await this.localFileToken(session, "upload");
    await this.requireDirect(token, "delivery");
    const header = fileFrameHeader(token, session, chunkIndex, bytes.byteLength);
    const encoded = await (await fileCipher(this.options.keyStore, token, session))
      .encryptChunk("upload_chunk", header, bytes);
    const response = await fetch(
      `${this.options.loopbackUrl}/v1/files/upload`,
      loopbackRequest({
        method: "POST",
        headers: { "content-type": "application/mdbase-connect-file" },
        body: Uint8Array.from(encoded).buffer,
        signal
      })
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw apiError(
        body,
        "operation_failed",
        "Encrypted file chunk upload failed.",
        response.status
      );
    }
    this.options.onDirectAvailable();
  }

  async downloadChunk(
    session: FileTransferSession,
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const token = await this.localFileToken(session, "download");
    await this.requireDirect(token, "delivery");
    const response = await fetch(
      `${this.options.loopbackUrl}/v1/files/download/${encodeURIComponent(token.grantId!)}/${encodeURIComponent(session.transfer_id)}/${chunkIndex}`,
      loopbackRequest({ method: "GET", signal })
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw apiError(
        body,
        "operation_failed",
        "Encrypted file chunk download failed.",
        response.status
      );
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]
        !== "application/mdbase-connect-file") {
      throw connectError(
        "invalid_operation_response",
        "The connector returned an invalid file response media type."
      );
    }
    const encoded = new Uint8Array(await response.arrayBuffer());
    let plaintext: Uint8Array;
    try {
      validateDownloadFrame(session, chunkIndex, encoded);
      plaintext = await (await fileCipher(this.options.keyStore, token, session))
        .decryptChunk(encoded);
    } catch (cause) {
      if (cause instanceof MdbaseConnectError) throw cause;
      throw connectError(
        "invalid_operation_response",
        "The connector returned an invalid encrypted file frame.",
        { cause }
      );
    }
    if (plaintext.byteLength !== expectedFramedChunkLength(session, chunkIndex)) {
      throw connectError(
        "invalid_operation_response",
        "The connector returned a truncated file chunk."
      );
    }
    this.options.onDirectAvailable();
    return plaintext;
  }

  private async localFileToken(
    session: FileTransferSession,
    direction: "upload" | "download"
  ): Promise<StoredToken> {
    const token = await this.options.authorizedToken();
    if (!token || token.authority || !token.fileCapability || !token.encryption
        || !token.grantId || !token.keyHandle
        || session.direction !== direction
        || session.protection !== "grant_aead_v1") {
      throw connectError(
        "not_authorized",
        "This connection cannot use encrypted local file delivery."
      );
    }
    framedChunkSize(session);
    return token;
  }

  private async requireDirect(token: StoredToken, purpose: string): Promise<void> {
    if (!await this.options.shouldAttemptDirect(token)) {
      throw connectError(
        "temporarily_unavailable",
        `Encrypted file relay ${purpose} is unavailable; enable direct access and retry.`
      );
    }
  }
}

function requireEncryption(token: StoredToken): void {
  if (!token.encryption || !token.grantId || !token.keyHandle) {
    throw connectError(
      "missing_grant_key",
      "Reconnect this application to restore encrypted file access."
    );
  }
}

function relayBinding(token: StoredToken) {
  requireEncryption(token);
  return {
    grantId: token.grantId!,
    applicationId: token.clientId,
    encryption: token.encryption!
  };
}

function fileCipher(
  keyStore: GrantKeyStore,
  token: StoredToken,
  session: FileTransferSession
): Promise<GrantFileTransferCipher> {
  requireEncryption(token);
  return GrantFileTransferCipher.open(keyStore, token.keyHandle!, {
    ...relayBinding(token),
    authorityId: token.encryption!.connector_id,
    transferId: session.transfer_id,
    direction: session.direction
  });
}

function fileFrameHeader(
  token: StoredToken,
  session: FileTransferSession,
  chunkIndex: number,
  plaintextLength: number
): FileFrameHeader {
  requireEncryption(token);
  const chunkSize = framedChunkSize(session);
  const expectedLength = expectedFramedChunkLength(session, chunkIndex);
  if (plaintextLength !== expectedLength) {
    throw connectError("invalid_request", "The file chunk has the wrong byte length.");
  }
  return {
    protocol_version: FILE_TRANSFER_PROTOCOL_VERSION,
    protection: "grant_aead_v1",
    grant_id: token.grantId!,
    authority_id: token.encryption!.connector_id,
    collection_id: token.collectionId,
    transfer_id: session.transfer_id,
    direction: session.direction,
    chunk_size: chunkSize,
    chunk_index: chunkIndex,
    offset: chunkIndex * chunkSize,
    plaintext_length: plaintextLength,
    total_size: session.total_size,
    scope_epoch: token.encryption!.scope_epoch,
    key_id: token.encryption!.key_id
  };
}

function validateDownloadFrame(
  session: FileTransferSession,
  chunkIndex: number,
  encoded: Uint8Array
): void {
  const frame = decodeFileFrame(encoded);
  const expectedLength = expectedFramedChunkLength(session, chunkIndex);
  const chunkSize = framedChunkSize(session);
  if (frame.kind !== "download_chunk"
      || frame.header.chunk_index !== chunkIndex
      || frame.header.chunk_size !== chunkSize
      || frame.header.offset !== chunkIndex * chunkSize
      || frame.header.plaintext_length !== expectedLength
      || frame.header.total_size !== session.total_size) {
    throw connectError(
      "invalid_operation_response",
      "The connector returned a file frame for a different chunk."
    );
  }
}

function throwEncryptedProblem(problem: ConnectProblem): never {
  throw serverConnectError(
    problem.code === "unknown" ? problem.server_code : problem.code,
    problem.message,
    {
      details: problem.details,
      operationOutcome: problem.operation_outcome ?? "rejected",
      traceId: problem.trace_id
    }
  );
}

function localFileControlInput(
  method: "GET" | "POST" | "DELETE",
  path: string,
  input: unknown
): Record<string, unknown> {
  if (method === "GET" && (path === "" || path.startsWith("?"))) {
    const query = new URLSearchParams(path.startsWith("?") ? path.slice(1) : path);
    const limit = query.get("limit");
    return {
      protocol_version: FILE_PROTOCOL_VERSION,
      type: "list_files",
      ...(query.get("folder") ? { folder: query.get("folder")! } : {}),
      ...(query.get("after") ? { after: query.get("after")! } : {}),
      ...(limit ? { limit: Number(limit) } : {})
    };
  }
  const segments = path.split("/");
  if (method === "GET" && segments.length === 2 && segments[0] === "transfers") {
    return transferControl("get_file_transfer_status", segments[1]!);
  }
  if (method === "DELETE" && segments.length === 2 && segments[0] === "transfers") {
    return transferControl("abort_file_transfer", segments[1]!);
  }
  if (method === "POST" && isRecord(input)) {
    const expectedType = path === "uploads"
      ? "open_file_upload"
      : path === "downloads"
        ? "open_file_download"
        : segments.length === 3 && segments[0] === "uploads" && segments[2] === "commit"
          ? "commit_file_upload"
          : null;
    if (expectedType && input.type === expectedType) return { ...input };
  }
  throw connectError("invalid_request", "The file control request path is invalid.");
}

function transferControl(type: string, encodedId: string): Record<string, unknown> {
  return {
    protocol_version: FILE_PROTOCOL_VERSION,
    type,
    transfer_id: decodeURIComponent(encodedId)
  };
}

function framedChunkSize(session: FileTransferSession): number {
  if (session.strategy.kind !== "framed_chunks"
      || !Number.isSafeInteger(session.strategy.chunk_size)
      || session.strategy.chunk_size <= 0) {
    throw connectError(
      "invalid_operation_response",
      "The connector returned an invalid framed transfer strategy."
    );
  }
  return session.strategy.chunk_size;
}

function expectedFramedChunkLength(session: FileTransferSession, chunkIndex: number): number {
  const chunkSize = framedChunkSize(session);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0
      || !Number.isSafeInteger(session.total_size) || session.total_size < 0) {
    throw connectError("invalid_request", "The file chunk index is invalid.");
  }
  const offset = chunkIndex * chunkSize;
  if (!Number.isSafeInteger(offset) || offset >= session.total_size) {
    throw connectError("invalid_request", "The file chunk index is outside the transfer.");
  }
  return Math.min(chunkSize, session.total_size - offset);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
