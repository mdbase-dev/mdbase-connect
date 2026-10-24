/**
 * Passing device secrets into the runtime Worker using a consuming secret transfer.
 *
 * The secrets blob comes from `DeviceKeyStore.load()`. It crosses into the Worker
 * once, as a **transferred** buffer, never a structured-clone copy, so no second copy
 * stays on the main thread. Whatever the main thread still holds is zeroed. The blob
 * is never logged, never put in an error message, and never journaled.
 */

/** Something with `postMessage(msg, transfer)`: a Worker, or `self` in a Worker. */
export interface TransferTarget {
  postMessage(msg: unknown, transfer: Transferable[]): void;
}

/**
 * Send `secrets` to the Worker as `{t: "mdbase-secrets", collection, secrets}`,
 * transferring its buffer, then zero anything left behind. The buffer is copied
 * first only if `secrets` is a view onto a larger buffer, and that copy is the one
 * transferred.
 */
export function transferSecrets(target: TransferTarget, collection: string, secrets: Uint8Array): void {
  const owned = secrets.byteOffset === 0 && secrets.byteLength === secrets.buffer.byteLength ? secrets : secrets.slice();
  try {
    target.postMessage({ t: "mdbase-secrets", collection, secrets: owned }, [owned.buffer as ArrayBuffer]);
  } finally {
    // After a successful transfer `owned` is detached (length 0). Zero the original
    // view (and `owned` if the transfer failed).
    if (owned.byteLength) owned.fill(0);
    if (secrets.byteLength) secrets.fill(0);
  }
}

/** A Worker-side holder that hands the bytes over once, then zeroes them. */
export class SecretsSlot {
  private bytes: Uint8Array | null = null;

  /** Accept the `mdbase-secrets` message. */
  receive(msg: { t?: string; secrets?: unknown }): boolean {
    if (msg?.t !== "mdbase-secrets" || !(msg.secrets instanceof Uint8Array)) return false;
    this.clear();
    this.bytes = msg.secrets;
    return true;
  }

  /** Give the bytes to `use` (copied into WASM memory by the ABI), then zero them. */
  take<T>(use: (secrets: Uint8Array) => T): T {
    if (!this.bytes) throw new Error("no device secrets");
    try {
      return use(this.bytes);
    } finally {
      this.clear();
    }
  }

  clear(): void {
    this.bytes?.fill(0);
    this.bytes = null;
  }

  /** Never print the bytes. */
  toJSON(): string {
    return "[device secrets]";
  }
}
