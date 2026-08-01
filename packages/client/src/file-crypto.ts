import {
  FILE_TRANSFER_PROTOCOL_VERSION,
  decodeFileFrame,
  encodeFileFrame,
  fileFrameAuthenticatedData,
  type FileFrameHeader,
  type FileFrameKind,
  type FileTransferDirection
} from "@mdbase-dev/connect-protocol";
import {
  RelayCryptoError,
  deriveP256SharedSecret,
  validateGrantEncryption,
  type GrantKeyStore,
  type RelayBinding
} from "./crypto.js";

const FILE_KEY_INFO = "mdbase-connect file chunk key v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FileTransferBinding extends RelayBinding {
  authorityId: string;
  transferId: string;
  direction: FileTransferDirection;
}

export class FileTransferCryptoError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "FileTransferCryptoError";
  }
}

/** Grant-bound, direction-separated cipher for one resumable file transfer. */
export class GrantFileTransferCipher {
  private constructor(
    private readonly binding: FileTransferBinding,
    private readonly key: CryptoKey
  ) {}

  static async open(
    store: GrantKeyStore,
    handle: string,
    binding: FileTransferBinding
  ): Promise<GrantFileTransferCipher> {
    validateFileTransferBinding(binding);
    const record = await store.get(handle);
    if (!record || record.agreementPublicKey !== binding.encryption.application_agreement_public_key) {
      throw new RelayCryptoError(
        "missing_grant_key",
        "The encrypted grant key is unavailable or does not match the file transfer grant."
      );
    }
    const sharedSecret = await deriveP256SharedSecret(
      record.agreementPrivateKey,
      binding.encryption.connector_agreement_public_key
    );
    return GrantFileTransferCipher.fromSharedSecret(sharedSecret, binding);
  }

  /** @internal Enables non-browser key-agreement adapters and compatibility tests. */
  static async fromSharedSecret(
    sharedSecret: BufferSource,
    binding: FileTransferBinding
  ): Promise<GrantFileTransferCipher> {
    validateFileTransferBinding(binding);
    const key = await deriveFileTransferKey(sharedSecret, binding);
    return new GrantFileTransferCipher(binding, key);
  }

  async encryptChunk(
    kind: FileFrameKind,
    header: FileFrameHeader,
    plaintext: Uint8Array
  ): Promise<Uint8Array> {
    this.validateHeader(header);
    if (plaintext.byteLength !== header.plaintext_length) {
      throw new FileTransferCryptoError(
        "plaintext_length_mismatch",
        "File chunk plaintext length does not match its authenticated header."
      );
    }
    const authenticatedData = fileFrameAuthenticatedData(kind, header);
    const payload = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv: chunkNonce(header.chunk_index),
      additionalData: arrayBuffer(authenticatedData),
      tagLength: 128
    }, this.key, arrayBuffer(plaintext));
    return encodeFileFrame({ kind, header, payload: new Uint8Array(payload) });
  }

  async decryptChunk(encoded: Uint8Array): Promise<Uint8Array> {
    const frame = decodeFileFrame(encoded);
    this.validateHeader(frame.header);
    const authenticatedData = fileFrameAuthenticatedData(frame.kind, frame.header);
    try {
      const plaintext = await crypto.subtle.decrypt({
        name: "AES-GCM",
        iv: chunkNonce(frame.header.chunk_index),
        additionalData: arrayBuffer(authenticatedData),
        tagLength: 128
      }, this.key, arrayBuffer(frame.payload));
      return new Uint8Array(plaintext);
    } catch {
      throw new FileTransferCryptoError(
        "authentication_failed",
        "The encrypted file chunk could not be authenticated."
      );
    }
  }

  private validateHeader(header: FileFrameHeader): void {
    const encryption = this.binding.encryption;
    if (header.protocol_version !== FILE_TRANSFER_PROTOCOL_VERSION
      || header.protection !== "grant_aead_v1"
      || header.grant_id !== this.binding.grantId
      || header.authority_id !== this.binding.authorityId
      || header.collection_id !== encryption.collection_id
      || header.transfer_id !== this.binding.transferId
      || header.direction !== this.binding.direction
      || header.scope_epoch !== encryption.scope_epoch
      || header.key_id !== encryption.key_id) {
      throw new FileTransferCryptoError(
        "header_binding_mismatch",
        "The file frame does not match its transfer encryption binding."
      );
    }
  }
}

/** @internal Deterministic HKDF profile shared with connector authorities. */
export async function deriveFileTransferKey(
  sharedSecret: BufferSource,
  binding: FileTransferBinding
): Promise<CryptoKey> {
  const contextBytes = new TextEncoder().encode(fileTransferContext(binding));
  const salt = await crypto.subtle.digest("SHA-256", contextBytes);
  const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: new TextEncoder().encode(FILE_KEY_INFO)
  }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function validateFileTransferBinding(binding: FileTransferBinding): void {
  validateGrantEncryption(binding.encryption);
  if (!UUID_PATTERN.test(binding.grantId)
    || !UUID_PATTERN.test(binding.applicationId)
    || !UUID_PATTERN.test(binding.authorityId)
    || !UUID_PATTERN.test(binding.transferId)
    || (binding.direction !== "upload" && binding.direction !== "download")) {
    throw new FileTransferCryptoError(
      "invalid_binding",
      "The file transfer encryption binding is invalid."
    );
  }
}

function fileTransferContext(binding: FileTransferBinding): string {
  const encryption = binding.encryption;
  return [
    "mdbase-connect",
    "file-transfer",
    FILE_TRANSFER_PROTOCOL_VERSION,
    encryption.suite,
    binding.grantId,
    binding.applicationId,
    encryption.connector_id,
    binding.authorityId,
    encryption.collection_id,
    encryption.scope_epoch,
    encryption.key_id,
    binding.transferId,
    binding.direction
  ].join("|");
}

function chunkNonce(index: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new FileTransferCryptoError("invalid_chunk_index", "The file chunk index is invalid.");
  }
  const nonce = new Uint8Array(new ArrayBuffer(12));
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
  return nonce;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
