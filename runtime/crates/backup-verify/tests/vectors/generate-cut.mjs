// Deterministic TEST-ONLY complete cuts: SDK CBOR + Node SHA-256/Ed25519.
// No Rust producer, network, provider, collection key or deployed signer.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { encode, structMap } from '../../../../packages/sdk/src/cbor.ts';
const sha = (bytes) => createHash('sha256').update(bytes).digest();
const label = (text) => sha(Buffer.from(text));
const id = (text) => label(text).subarray(0, 16);
const enc = (value) => Buffer.from(encode(value));
const map = (values) => structMap(values.map((value, index) => [index, value]));
const hash = (tag, bytes) => sha(Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag), bytes]));
const key = (text) => createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), label(text),
]), type: 'pkcs8', format: 'der' });
const pk = (key) => createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
const signature = (key, tag, value) => sign(null, hash(tag, enc(value)), key);
const signedItem = (key, value) => {
  value.set(12, signature(key, 'mdbase/v1/item-sig', value));
  return enc(value);
};
const sorted = (values) => [...new Map(values.map((value) => [value.toString('hex'), value])).values()].sort(Buffer.compare);
const chain = (bytes) => hash('mdbase/v1/chain', bytes);
const prefix = 'offline/test-only/full-cut';
const c = id(`${prefix}/collection`), owner = id(`${prefix}/owner`), session = id(`${prefix}/session`);
const root = key(`${prefix}/root`), policy = key(`${prefix}/policy`);
const deviceLabel = `device/${prefix}/device`, publisherLabel = `device/${prefix}/publisher`;
const device = id(deviceLabel), publisher = id(publisherLabel), deviceKey = key(deviceLabel);
const cert = map([pk(policy), 0, 9223372036854775807n, sha(pk(root)).subarray(0, 16)]);
cert.set(4, signature(root, 'mdbase/v1/cp-cert', cert));
const policyItem = (seq, prev, ops) => signedItem(policy, structMap([
  [0, 1], [1, 2], [2, c], [3, seq], [4, prev], [6, sha(pk(policy)).subarray(0, 16)],
  [11, enc(map([1, cert, seq, ops]))],
]));
const genesis = policyItem(1, Buffer.alloc(32), [structMap([
  [0, 1], [1, owner], [2, sha(pk(root)).subarray(0, 16)], [3, 0],
])]);
const enrol = (text) => structMap([
  [0, 2], [1, id(text)], [2, owner], [3, 0], [4, pk(key(text))],
  [5, hash('kem', id(text))], [6, hash('noise', id(text))],
]);
const enrolled = policyItem(2, chain(genesis), [enrol(deviceLabel), enrol(publisherLabel)]);
const seqBytes = Buffer.alloc(8); seqBytes.writeBigUInt64BE(3n);
const rekeyBody = enc(map([1, 1, 0, hash('commit', seqBytes), [map([
  device, hash('enc', device), Buffer.alloc(48, 7),
])], map([Buffer.alloc(16, 1), Buffer.alloc(32, 2)]), 0]));
const rekey = signedItem(deviceKey, structMap([
  [0, 1], [1, 3], [2, c], [3, 3], [4, chain(enrolled)], [6, device], [11, rekeyBody],
]));
const sealedObject = (kind, body) => enc(structMap([
  [0, 1], [1, kind], [2, c], [5, 1], [7, sha(body).subarray(0, 16)], [11, body],
]));
const roll = (name, rows) => rows.reduce((previous, row) => sha(Buffer.concat([previous, enc(row)])), label(`mdbase-next-backup/1/${name}`));
for (const [name, compacted, indexed, different, extra, large] of [
  ['ordinary', false, false, false, false, false],
  ['compacted', true, false, false, false, false],
  ['indexed-extra-publisher', false, true, true, true, false],
  ['near9', false, false, false, false, true],
]) {
  const head = compacted ? 9 : 4, rf = compacted ? 9 : 1, revision = 12;
  const blob = sealedObject(18, Buffer.alloc(large ? 9 * 1024 * 1024 - 1024 : 64, 5));
  const chunk = sealedObject(17, Buffer.alloc(64, 6)), orphan = sealedObject(17, Buffer.alloc(64, 7));
  const blobAddress = sha(blob), chunkAddress = sha(chunk), orphanAddress = sha(orphan);
  const objects = [[blobAddress, blob, 18], [chunkAddress, chunk, 17], [orphanAddress, orphan, 17]];
  let direct = [blobAddress, chunkAddress];
  if (indexed) {
    const index = (members) => enc(structMap([
      [0, 1], [1, 19], [2, c], [11, enc(map([1, Buffer.concat(sorted(members))]))],
    ]));
    const first = index(direct), second = index([blobAddress]);
    objects.push([sha(first), first, 19], [sha(second), second, 19]);
    direct = [sha(first), sha(second)];
  }
  direct = sorted(direct);
  const manifestBody = Buffer.alloc(64, 8);
  const manifest = signedItem(deviceKey, structMap([
    [0, 1], [1, 16], [2, c], [5, 1], [6, device], [7, sha(manifestBody).subarray(0, 16)],
    [9, direct], [11, manifestBody],
  ]));
  const manifestAddress = sha(manifest);
  objects.push([manifestAddress, manifest, 16]); objects.sort((a, b) => Buffer.compare(a[0], b[0]));
  const token = id(`${prefix}/idem/${head}`), entryBody = Buffer.alloc(64, 9);
  const entry = signedItem(deviceKey, structMap([
    [0, 1], [1, 1], [2, c], [3, head], [4, compacted ? Buffer.alloc(32, 21) : chain(rekey)],
    [5, 1], [6, device], [7, sha(entryBody).subarray(0, 16)], [8, token],
    [9, [blobAddress]], [11, entryBody],
  ]));
  const items = [[1, genesis, 2], [2, enrolled, 2], [3, rekey, 3], [head, entry, 1]];
  const finalChain = chain(entry), author = different ? publisher : device;
  const roots = sorted([manifestAddress, blobAddress, chunkAddress, ...direct, ...(extra ? [orphanAddress] : [])]);
  const pointers = [[3, manifestAddress, author, 103, 0], [head, manifestAddress, author, 104, 1]];
  const refs = [[1, blobAddress, 0, head]];
  for (const seq of [3, head]) for (const address of roots) refs.push([refs.length + 1, address, 1, seq]);
  const metadata = objects.map(([address, raw, kind], index) => [index + 1, address, kind, raw.length, sha(raw), 200 + index]);
  const tokens = [[token, head, -5], ...(compacted ? [[id(`${prefix}/expired-compacted`), 4, -9]] : [])];
  tokens.sort((a, b) => Buffer.compare(a[0], b[0]));
  const sections = [items.map(([seq, raw, kind]) => [seq, kind, raw, seq + 100]), pointers, refs,
    metadata, tokens.map((row, index) => [index + 1, ...row]), [[1, Buffer.alloc(32, 19), 120]]];
  const objectBytes = objects.reduce((total, [, raw]) => total + raw.length, 0);
  const used = objectBytes + items.reduce((total, [, raw]) => total + raw.length, 0);
  const itemRoot = roll('items', items.map(([seq, raw]) => [seq, sha(raw)]));
  const objectRoot = roll('objects', metadata.map(([, address, kind, size, checksum]) => [address, kind, size, checksum]));
  const snapshotRows = [...pointers].reverse().flatMap(([seq, address, author, time, endorsed]) => [
    [seq, address, author, time, Boolean(endorsed), roots.length], ...roots,
  ]);
  const plan = [1, used, head, finalChain, rf, itemRoot, objectRoot, roll('snapshots', snapshotRows)];
  const header = enc(map(['mdbase-next-backup/1', c, session, head, finalChain, rf, revision,
    [1, [1000, 1000, 1000, 1000], 30, 100], 200, used, 'rotate-url-secret-before-restored-traffic']));
  const pages = []; let previous = sha(header);
  sections.forEach((rows, section) => {
    const batches = []; const limit = section === 0 ? 32 : 100;
    for (let start = 0; start < rows.length; start += limit) batches.push(rows.slice(start, start + limit));
    batches.push([]);
    for (const batch of batches) {
      const raw = enc(map([1, c, session, revision, pages.length + 1, previous, section + 1,
        batch, batch.length === 0, head, finalChain]));
      previous = sha(raw); pages.push(raw);
    }
  });
  const finish = enc(map([1, c, session, head, finalChain, revision, pages.length, previous]));
  const completionKey = key('offline/test-only/completion-signer'), context = label('offline/test-only/capture-context');
  const trust = enc(map(['mdbase-native-backup-trust/1', 'backup-completion', 'offline-test', c,
    pk(completionKey), [pk(root)], context, sha(genesis)]));
  const completion = map(['mdbase-native-backup-completion/1', 'backup-completion', 'offline-test', c,
    sha(header), pages.length, previous, plan, objects.length, objectBytes, context, sha(finish)]);
  completion.set(12, signature(completionKey, 'mdbase/v1/native-backup-completion', completion));
  const vector = { trust, completion: enc(completion), header, finish,
    ...Object.fromEntries(pages.map((raw, index) => [`page${index + 1}`, raw])),
    // The near9 object is reconstructed from its public test-only filler; keep
    // its independent whole-byte hash rather than committing 18MB of hex.
    ...Object.fromEntries(objects.map(([address, raw]) => [
      `${large ? 'object_hash' : 'object'}_${address.toString('hex')}`, large ? sha(raw) : raw,
    ])),
  };
  writeFileSync(new URL(`./cut-${name}-v1.txt`, import.meta.url),
    Object.entries(vector).map(([field, raw]) => `${field}=${raw.toString('hex')}\n`).join(''));
}
