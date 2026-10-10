// Offline TEST vector only. No release/archive signer, credential or provider.
// Run from repo root: node --experimental-transform-types crates/backup-verify/tests/vectors/generate-completion.mjs
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { encode, structMap } from '../../../../packages/sdk/src/cbor.ts';
const sha = (bytes) => createHash('sha256').update(bytes).digest();
const digest = (label) => sha(Buffer.from(label));
const domain = 'mdbase/v1/native-backup-completion';
const hash = (bytes) => sha(Buffer.concat([Buffer.from([domain.length]), Buffer.from(domain), bytes]));
const seed = digest('offline/test-only/completion-signer');
const key = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
]), type: 'pkcs8', format: 'der' });
const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const collection = Buffer.alloc(16, 0x31), context = digest('offline/test-only/capture-context');
const trust = structMap([
  [0, 'mdbase-native-backup-trust/1'], [1, 'backup-completion'], [2, 'offline-test'],
  [3, collection], [4, publicKey], [5, [Buffer.alloc(32, 0x21)]],
  [6, context], [7, digest('test-only-genesis')],
]);
const completion = structMap([
  [0, 'mdbase-native-backup-completion/1'], [1, 'backup-completion'], [2, 'offline-test'],
  [3, collection], [4, digest('test-only-header')], [5, 6],
  [6, digest('test-only-final-page')],
  [7, [1, 999, 1, Buffer.alloc(32, 0x42), 1, Buffer.alloc(32, 0x43), Buffer.alloc(32, 0x44), Buffer.alloc(32, 0x45)]],
  [8, 1], [9, 100], [10, context], [11, digest('test-only-finish')],
]);
const unsigned = Buffer.from(encode(completion));
const message = hash(unsigned), signature = sign(null, message, key);
completion.set(12, signature);
const vector = { trust: Buffer.from(encode(trust)), unsigned, domain_digest: message,
  public_key: publicKey, signature, completion: Buffer.from(encode(completion)) };
writeFileSync(new URL('./completion-v1.txt', import.meta.url),
  Object.entries(vector).map(([name, bytes]) => `${name}=${bytes.toString('hex')}\n`).join(''));
