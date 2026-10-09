// Fixed LAB native-log capture. Completion authenticates the observed historical
// cut, not hosted durable state, current liveness, target emptiness or serving.
import { createHash, sign } from "node:crypto";
import { decodeCbor, domainHash, encodeCbor, uuidBytes, type Cbor, type Decoded, type PolicySigner } from "./policy-wire.js";
import type { LogServiceClient, NativeRestorePlan } from "./log-service-client.js";

const MAX_PAGES = 1024;
const MAX_ROWS = 16_384;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT = 9 * 1024 * 1024;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();
const map = (values: Cbor[]): Cbor => ({struct: values.map((value, key) => [key, value])});
const fail = (): never => { throw new Error("lab_native_backup_cut_refused"); };
function equal(a: Uint8Array, b: Uint8Array): boolean { return Buffer.from(a).equals(Buffer.from(b)); }
function uint(value: Decoded | undefined, max = Number.MAX_SAFE_INTEGER, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) return fail();
  return value;
}
function bytes(value: Decoded | undefined, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) return fail();
  return value;
}
function fields(raw: Uint8Array, count: number): Map<number, Decoded> {
  const value = decodeCbor(raw, {canonicalStructs: true, maxDepth: 32});
  if (!(value instanceof Map) || value.size !== count || [...value.keys()].some((key, index) => key !== index)) return fail();
  return value as Map<number, Decoded>;
}
function row(value: Decoded, count: number): Decoded[] {
  if (!Array.isArray(value) || value.length !== count) return fail();
  return value;
}
function roll(previous: Uint8Array, value: Cbor): Uint8Array { return sha(Buffer.concat([previous, encodeCbor(value)])); }
interface ObjectRow {address: Uint8Array; kind: number; size: number; checksum: Uint8Array}
interface Snapshot {seq: number; manifest: Uint8Array; author: Uint8Array; created: number; endorsed: boolean; refs: Uint8Array[]}

export interface LabNativeCut {
  header: Uint8Array; finish: Uint8Array; pages: Uint8Array[];
  objects: Array<{address: Uint8Array; bytes: Uint8Array}>;
  completion: Uint8Array; captureContext: Uint8Array; plan: NativeRestorePlan;
}
/** Server-owned bindings, assembled by the fixed authenticated admin entrypoint.
 * No caller-provided digest, signing bytes, signer or arbitrary RPC method. */
export interface LabNativeCaptureContext {
  collection: string; operationId: string; sourceOrigin: string; runtimeRevision: string;
  originalGenesis: Uint8Array; signer: PolicySigner; log: LogServiceClient;
  /** Fresh authoritative CP read, before every remote phase and signing. */
  denyFirst(): Promise<void>;
}

export async function captureLabNativeCut(context: LabNativeCaptureContext): Promise<LabNativeCut> {
  const collection = uuidBytes(context.collection);
  await context.denyFirst();
  const begin = await context.log.backupBegin(context.collection);
  const header = fields(begin.raw, 11);
  const session = bytes(header.get(2), 16), head = uint(header.get(3), Number.MAX_SAFE_INTEGER - 1, true);
  const chain = bytes(header.get(4), 32), retainedFrom = uint(header.get(5), head + 1, true), revision = uint(header.get(6), 2 ** 52, true);
  const used = uint(header.get(9), MAX_BYTES);
  if (header.get(0) !== "mdbase-next-backup/1" || !equal(bytes(header.get(1), 16), collection) || header.get(10) !== "rotate-url-secret-before-restored-traffic" || !equal(begin.hash, sha(begin.raw))) return fail();
  const pages: Uint8Array[] = [], objects: ObjectRow[] = [], snapshots: Snapshot[] = [];
  const refs: Array<{address: Uint8Array; kind: number; holder: number}> = [];
  let section = 1, after = 0, previous = begin.hash, retainedBytes = 0, rowsSeen = 0, itemBytes = 0, lastItem = 0;
  let itemRoot: Uint8Array = sha("mdbase-next-backup/1/items"), genesisSeen = false;
  // A transport failure has UNKNOWN outcome. Deliberately do not retry or issue
  // an automatic abort: retained session/cursor data is for operator readback.
  while (section <= 6) {
    if (pages.length >= MAX_PAGES) return fail();
    await context.denyFirst();
    const frame = await context.log.backupPage(context.collection, session, pages.length + 1, previous);
    retainedBytes += frame.raw.length;
    if (retainedBytes > MAX_BYTES || !equal(frame.hash, sha(frame.raw))) return fail();
    const page = fields(frame.raw, 11), values = page.get(7), terminal = page.get(8);
    if (page.get(0) !== 1 || !equal(bytes(page.get(1), 16), collection) || !equal(bytes(page.get(2), 16), session)
      || page.get(3) !== revision || page.get(4) !== pages.length + 1 || !equal(bytes(page.get(5), 32), previous)
      || page.get(6) !== section || page.get(9) !== head || !equal(bytes(page.get(10), 32), chain)
      || !Array.isArray(values) || typeof terminal !== "boolean" || terminal !== (values.length === 0) || values.length > (section === 1 ? 32 : 100)) return fail();
    for (const value of values) {
      if (++rowsSeen > MAX_ROWS) return fail();
      const values = row(value, [0, 4, 5, 4, 6, 4, 3][section]!);
      const cursor = uint(values[0], Number.MAX_SAFE_INTEGER, true);
      if (cursor <= after || section <= 2 && cursor > head) return fail();
      after = cursor;
      if (section === 1) {
        const raw = values[2];
        if (!(raw instanceof Uint8Array) || raw.length === 0 || raw.length > 4 * 1024 * 1024 || ![1, 2, 3].includes(uint(values[1]))) return fail();
        if (cursor === 1) { if (!equal(raw, context.originalGenesis)) return fail(); genesisSeen = true; }
        if (!genesisSeen || cursor <= lastItem) return fail();
        itemRoot = roll(itemRoot, [cursor, sha(raw)]); itemBytes += raw.length; lastItem = cursor;
      } else if (section === 2) {
        if (snapshots.length >= 1024 || !Number.isSafeInteger(values[3]) || ![0, 1].includes(uint(values[4], 1))) return fail();
        snapshots.push({seq: cursor, manifest: bytes(values[1], 32), author: bytes(values[2], 16), created: values[3] as number, endorsed: values[4] === 1, refs: []});
      } else if (section === 3) {
        refs.push({address: bytes(values[1], 32), kind: uint(values[2], 1), holder: uint(values[3], head, true)});
      } else if (section === 4) {
        const kind = uint(values[2]);
        if (objects.length >= 4096 || ![16, 17, 18, 19].includes(kind)) return fail();
        objects.push({address: bytes(values[1], 32), kind, size: uint(values[3], MAX_OBJECT, true), checksum: bytes(values[4], 32)});
      } else if (section === 5) {
        bytes(values[1], 16); uint(values[2], head, true); if (!Number.isSafeInteger(values[3])) return fail();
      } else {
        bytes(values[1], 32); if (!Number.isSafeInteger(values[2])) return fail();
      }
    }
    pages.push(frame.raw); previous = frame.hash;
    if (terminal) {section++; after = 0;}
  }
  if (!genesisSeen || lastItem !== head) return fail();
  objects.sort((a, b) => Buffer.compare(a.address, b.address));
  let objectRoot: Uint8Array = sha("mdbase-next-backup/1/objects"), objectBytes = 0;
  const committed = new Set<string>();
  for (const object of objects) {
    const key = Buffer.from(object.address).toString("hex");
    if (committed.has(key) || !equal(object.address, object.checksum)) return fail();
    committed.add(key); objectBytes += object.size;
    if (objectBytes + retainedBytes > MAX_BYTES) return fail();
    objectRoot = roll(objectRoot, [object.address, object.kind, object.size, object.checksum]);
  }
  for (const ref of refs) {
    if (!committed.has(Buffer.from(ref.address).toString("hex"))) return fail();
    if (ref.kind === 1) {
      const snapshot = snapshots.find(snapshot => snapshot.seq === ref.holder);
      if (!snapshot) return fail();
      snapshot.refs.push(ref.address);
    }
  }
  let snapshotRoot: Uint8Array = sha("mdbase-next-backup/1/snapshots");
  for (const snapshot of [...snapshots].reverse()) {
    snapshot.refs.sort(Buffer.compare);
    if (!snapshot.refs.some(ref => equal(ref, snapshot.manifest)) || snapshot.refs.some((ref, index) => index > 0 && equal(ref, snapshot.refs[index - 1]!))) return fail();
    snapshotRoot = roll(snapshotRoot, [snapshot.seq, snapshot.manifest, snapshot.author, snapshot.created, snapshot.endorsed, snapshot.refs.length]);
    for (const ref of snapshot.refs) snapshotRoot = roll(snapshotRoot, ref);
  }
  if (itemBytes + objectBytes !== used) return fail();
  const captured: LabNativeCut["objects"] = [];
  for (const object of objects) {
    const raw = Buffer.alloc(object.size);
    for (let offset = 0; offset < object.size;) {
      await context.denyFirst();
      const length = Math.min(1024 * 1024, object.size - offset);
      const part = await context.log.nativeObjectRange(context.collection, object.address, offset, length);
      if (part.size !== object.size || !equal(part.checksum, object.checksum)) return fail();
      raw.set(part.bytes, offset); offset += length;
    }
    if (!equal(sha(raw), object.checksum)) return fail();
    captured.push({address: object.address, bytes: raw});
  }
  // FIRST FINISH only AFTER every object has been copied and verified. FINISH
  // releases ordinary GC/retention fencing; replay does not restore that lease.
  await context.denyFirst();
  const final = await context.log.backupFinish(context.collection, session, previous);
  if (final.head !== head || final.revision !== revision || final.pageCount !== pages.length || !equal(final.chain, chain)) return fail();
  await context.denyFirst();
  const plan: NativeRestorePlan = [1, used, head, chain, retainedFrom, itemRoot, objectRoot, snapshotRoot];
  const captureContext = encodeCbor(map(["mdbase-lab-native-log-capture/1", "lab", "https://connect-lab.mdbase.dev", context.sourceOrigin,
    collection, uuidBytes(context.operationId), context.runtimeRevision, sha(context.originalGenesis), begin.hash]));
  const unsignedFields: Cbor[] = ["mdbase-native-backup-completion/1", "backup-completion", "lab", collection,
    begin.hash, pages.length, previous, [...plan], objects.length, objectBytes, sha(captureContext), sha(final.raw)];
  const signature = sign(null, domainHash("mdbase/v1/native-backup-completion", encodeCbor(map(unsignedFields))), context.signer.privateKey);
  return {header: begin.raw, finish: final.raw, pages, objects: captured, captureContext, plan, completion: encodeCbor(map([...unsignedFields, signature]))};
}
