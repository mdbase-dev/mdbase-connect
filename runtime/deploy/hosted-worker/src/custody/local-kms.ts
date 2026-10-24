/** Per-stack software KMS behind the existing hosted wrapper/unwrap seam.
 * Compiled local builds only. AES-GCM binds the key reference, environment,
 * collection, device and purpose. No network or persistence; all buffers owned.
 * MDBK remains the existing KMS envelope wire format, not a custody exemption. */
import { LOCAL_REHEARSAL_BUILD } from '#hosted-local-build';
import { configuredEnvelope, encodeEnvelope } from './envelope.ts';
import { allowlist } from './aws-kms.ts';
import type { KmsAllowlist } from './kms-allowlist.ts';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const validUuid = (id: string) => UUID.test(id) && id !== '00000000-0000-0000-0000-000000000000';
export function localKeyReference(value: string): boolean {
  const prefix = 'arn:local:kms:local:000000000000:key/';
  return LOCAL_REHEARSAL_BUILD && value.startsWith(prefix) && validUuid(value.slice(prefix.length));
}

export class LocalSoftwareKms {
  private readonly keyBytes: Uint8Array;
  private readonly collections: KmsAllowlist;
  constructor(private readonly keyArn: string, keyHex: string, environment: string, collections: KmsAllowlist | readonly string[]) {
    if (!LOCAL_REHEARSAL_BUILD || environment !== 'local' || !localKeyReference(keyArn) || !/^[0-9a-f]{64}$/.test(keyHex)) throw Error('kms_invalid_config');
    this.collections = allowlist(collections);
    this.keyBytes = Uint8Array.from(keyHex.match(/../g)!, value => parseInt(value, 16));
  }
  private context(collection: string, device: string): Uint8Array {
    if (!validUuid(collection) || !validUuid(device) || !this.collections.has(collection)) throw Error('kms_collection_not_allowed');
    return new TextEncoder().encode(JSON.stringify(['mdbase/local-kms/1', this.keyArn, 'local', collection, device, 'device-key']));
  }
  private async key(): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', this.keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async wrapDeviceKeys(input: { collection: string; device: string; secret: Uint8Array }, signal: AbortSignal): Promise<{ envelope: Uint8Array; kmsKeyArn: string }> {
    signal.throwIfAborted();
    if (input.secret.length !== 96) throw Error('custody_secret_invalid');
    const aad = this.context(input.collection, input.device), nonce = crypto.getRandomValues(new Uint8Array(12));
    const copy = input.secret.slice();
    try {
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await this.key(), copy));
      signal.throwIfAborted();
      const payload = new Uint8Array(12 + cipher.length); payload.set(nonce); payload.set(cipher, 12);
      return { envelope: encodeEnvelope(this.keyArn, payload), kmsKeyArn: this.keyArn };
    } finally { copy.fill(0); }
  }
  async unwrapDeviceKeys(collection: string, device: string, envelope: Uint8Array, reportedArn: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    if (reportedArn !== this.keyArn) throw Error('custody_key_not_configured');
    const payload = configuredEnvelope(envelope, [this.keyArn]).ciphertext;
    const aad = this.context(collection, device);
    if (payload.length !== 12 + 96 + 16) throw Error('custody_envelope_invalid');
    let plain: Uint8Array;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12), additionalData: aad }, await this.key(), payload.slice(12))); }
    catch { throw Error('kms_refused'); }
    if (signal.aborted || plain.length !== 96) { plain.fill(0); throw Error(signal.aborted ? 'kms_aborted' : 'custody_secret_invalid'); }
    return plain;
  }
}
