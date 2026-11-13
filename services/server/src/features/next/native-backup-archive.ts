// Native-log archive composition only. No scheduler, credentials, deployment,
// hosted SQL capture, key recovery or current-authority assertion lives here.
import { createHash } from "node:crypto";
import { captureLabNativeCut, type LabNativeCaptureContext, type LabNativeCut } from "./lab-native-backup.js";
import type { LogServiceClient, NativeRestorePlan, NativeRestoreSettings } from "./log-service-client.js";
import { decodeCbor, type Decoded } from "./policy-wire.js";
import { nativeArchivePath, verifyNativeArchive, type NativeArchiveFiles, type NativeBackupVerifier } from "./native-backup-verifier.js";

const MAX_BYTES = 64 * 1024 * 1024, MAX_ENTRIES = 5124, MANIFEST_BYTES = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hex = (value: Decoded | undefined): string => {
  if (!(value instanceof Uint8Array)) throw new Error("native_backup_bytes");
  return Buffer.from(value).toString("hex");
};
const fields = (raw: Uint8Array): Map<number, Decoded> => {
  const result = decodeCbor(raw, {canonicalStructs: true, maxDepth: 32});
  if (!(result instanceof Map)) throw new Error("native_backup_shape");
  return result as Map<number, Decoded>;
};
const required = (files: NativeArchiveFiles, name: string): Uint8Array => {
  const raw = files.get(name);
  if (!raw) throw new Error("native_backup_missing_entry");
  return raw;
};
/** One fresh operation prefix in an independent bucket, not the live object store.
 * Writes MUST be atomic create-only; reads MUST enforce the supplied byte limit. */
export interface NativeBackupStore {
  putIfAbsent(name: string, bytes: Uint8Array): Promise<void>;
  read(name: string, maxBytes: number): Promise<Uint8Array>;
}
export interface NativeBackupCoverage {
  schema: "mdbase-native-backup-coverage/1";
  scope: "native-log-only";
  current_authority_verified: false;
  S_final: {
    collection: string; head: number; chain: string; revision: number; retained_from: number;
    used_bytes: number; item_root: string; object_root: string; snapshot_root: string;
    page_count: number; final_hash: string; object_count: number; object_bytes: number;
    header_sha256: string; finish_sha256: string; completion_sha256: string; capture_context_sha256: string;
  };
  entries: Array<{name: string; bytes: number; sha256: string}>;
}
function coverage(files: NativeArchiveFiles): NativeBackupCoverage {
  const header = required(files, "cut/header.cbor"), finish = required(files, "cut/finish.cbor");
  const completion = required(files, "completion.cbor"), context = required(files, "capture-context.cbor");
  const h = fields(header), c = fields(completion), plan = c.get(7) as Decoded[];
  if (sha(context) !== hex(c.get(10))) throw new Error("native_backup_context_binding");
  const id = hex(h.get(1));
  return {schema: "mdbase-native-backup-coverage/1", scope: "native-log-only", current_authority_verified: false,
    S_final: {collection: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`,
      head: h.get(3) as number, chain: hex(h.get(4)), revision: h.get(6) as number, retained_from: h.get(5) as number,
      used_bytes: plan[1] as number, item_root: hex(plan[5]), object_root: hex(plan[6]), snapshot_root: hex(plan[7]),
      page_count: c.get(5) as number, final_hash: hex(c.get(6)), object_count: c.get(8) as number, object_bytes: c.get(9) as number,
      header_sha256: sha(header), finish_sha256: sha(finish), completion_sha256: sha(completion), capture_context_sha256: sha(context)},
    entries: [...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([name, raw]) => ({name, bytes: raw.length, sha256: sha(raw)}))};
}
function cutFiles(cut: LabNativeCut): Map<string, Uint8Array> {
  return new Map([
    ["cut/header.cbor", cut.header], ["cut/finish.cbor", cut.finish], ["completion.cbor", cut.completion], ["capture-context.cbor", cut.captureContext],
    ...cut.pages.map((raw, i): [string, Uint8Array] => [`cut/pages/${String(i + 1).padStart(10, "0")}.cbor`, raw]),
    ...cut.objects.map((object): [string, Uint8Array] => [`cut/objects/${Buffer.from(object.address).toString("hex")}.cbor`, object.bytes]),
  ]);
}
const manifestBytes = (manifest: NativeBackupCoverage) => Buffer.from(JSON.stringify(manifest));
/** Archive the observed cut; authenticate and verify persisted readback BEFORE
 * publishing coverage.json. Failure leaves an incomplete, unusable operation.
 * No automatic retry/abort (an ambiguous remote outcome needs owner readback). */
export async function exportNativeBackup(input: {
  capture: LabNativeCaptureContext; sink: NativeBackupStore; verifier: NativeBackupVerifier;
}): Promise<NativeBackupCoverage> {
  const files = cutFiles(await captureLabNativeCut(input.capture));
  for (const [name, bytes] of files) await input.sink.putIfAbsent(name, bytes);
  return publishNativeBackupCoverage(files, input.sink, input.verifier, input.capture.denyFirst);
}
/** Also closes an existing #686 admin capture after independent trust arrives.
 * Readback and native authentication precede the sole create-only publication. */
export async function publishNativeBackupCoverage(files: NativeArchiveFiles, sink: NativeBackupStore,
  verifier: NativeBackupVerifier, beforePublish: () => Promise<void>): Promise<NativeBackupCoverage> {
  for (const [name, bytes] of files) {
    const readback = await sink.read(name, bytes.length);
    if (readback.length !== bytes.length || sha(readback) !== sha(bytes)) throw new Error("native_backup_sink_readback");
  }
  await verifyNativeArchive(files, verifier);
  const manifest = coverage(files);
  await beforePublish();
  const raw = manifestBytes(manifest);
  if (raw.length > MANIFEST_BYTES) throw new Error("native_backup_manifest_bound");
  await sink.putIfAbsent("coverage.json", raw);
  if (!Buffer.from(await sink.read("coverage.json", raw.length)).equals(raw)) throw new Error("native_backup_manifest_readback");
  return manifest;
}
async function loadArchive(source: NativeBackupStore, verifier: NativeBackupVerifier): Promise<{files: NativeArchiveFiles; manifest: NativeBackupCoverage}> {
  const raw = await source.read("coverage.json", MANIFEST_BYTES);
  if (raw.length > MANIFEST_BYTES) throw new Error("native_backup_manifest_bound");
  const m = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw)) as NativeBackupCoverage;
  if (m?.schema !== "mdbase-native-backup-coverage/1" || !Array.isArray(m.entries) || m.entries.length > MAX_ENTRIES) throw new Error("native_backup_manifest_shape");
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of m.entries) {
    if (!entry || typeof entry.name !== "string" || !nativeArchivePath(entry.name) || files.has(entry.name)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 9 * 1024 * 1024
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("native_backup_manifest_entry");
    total += entry.bytes;
    if (total > MAX_BYTES + 256 * 1024) throw new Error("native_backup_archive_bound");
    const bytes = await source.read(entry.name, entry.bytes);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error("native_backup_archive_hash");
    files.set(entry.name, bytes);
  }
  await verifyNativeArchive(files, verifier);
  const manifest = coverage(files);
  // No caller-supplied S_final claims survive: recompute from authenticated cut.
  if (!manifestBytes(manifest).equals(Buffer.from(raw))) throw new Error("native_backup_coverage_binding");
  return {files, manifest};
}
/** Gate readers can authenticate coverage without touching any target. */
export async function verifyNativeBackup(source: NativeBackupStore, verifier: NativeBackupVerifier): Promise<NativeBackupCoverage> {
  return (await loadArchive(source, verifier)).manifest;
}

type RestoreLog = Pick<LogServiceClient, "importNativeItems" | "importNativeObject" | "importNativeSnapshot" | "restoreAuxBegin" | "restoreAuxPage" | "head">;
/** Original collection identity is preserved. The target MUST be a separate empty
 * scratch namespace. The owner supplies a target-bound admission closure, which
 * checks EMPTY initially, then current deletion/revocation/isolation before each
 * effect. This module cannot establish CP/namespace authority from an archive. */
export async function restoreNativeBackup(input: {
  source: NativeBackupStore; verifier: NativeBackupVerifier; target: RestoreLog;
  admit(phase: "empty" | "write" | "activate", coverage: NativeBackupCoverage): Promise<void>;
}): Promise<NativeBackupCoverage> {
  const {files, manifest} = await loadArchive(input.source, input.verifier);
  const h = fields(required(files, "cut/header.cbor")), c = fields(required(files, "completion.cbor"));
  const collection = manifest.S_final.collection, plan = c.get(7) as unknown as NativeRestorePlan;
  const pages = [...files].filter(([name]) => name.startsWith("cut/pages/")).sort(([a], [b]) => a.localeCompare(b));
  const sections = new Map<number, Decoded[][]>();
  for (const [, raw] of pages) {
    const page = fields(raw), section = page.get(6) as number;
    const rows = page.get(7) as Decoded[][];
    sections.set(section, [...(sections.get(section) ?? []), ...rows]);
  }
  const items = sections.get(1)!, objects = sections.get(4)!, snapshots = sections.get(2)!, refs = sections.get(3)!;
  // Preflight the adapter's smaller import bound BEFORE the first target effect.
  const expanded = snapshots.map(s => refs.filter(r => r[2] === 1 && r[3] === s[0]).map(r => r[1] as Uint8Array));
  if (expanded.some(r => r.length > 1024)) throw new Error("native_backup_restore_refs_bound");
  await input.admit("empty", manifest);
  const first = items[0]!;
  const seeded = await input.target.importNativeItems(collection, {items: [[1, first[2] as Uint8Array]], settings: h.get(7) as unknown as NativeRestoreSettings, plan});
  if (!seeded.strict || seeded.live || seeded.head !== 1) throw new Error("native_backup_restore_seed");
  await input.admit("write", manifest);
  const begun = await input.target.restoreAuxBegin(collection, required(files, "cut/header.cbor"), Buffer.from(manifest.S_final.final_hash, "hex"), pages.length);
  if (begun.page !== 0 || hex(begun.hash) !== sha(required(files, "cut/header.cbor"))) throw new Error("native_backup_restore_aux_begin");
  for (const object of objects) {
    await input.admit("write", manifest);
    await input.target.importNativeObject(collection, object[1] as Uint8Array, object[2] as number, required(files, `cut/objects/${hex(object[1])}.cbor`));
  }
  for (let i = 1; i < items.length; i += 16) {
    await input.admit("write", manifest);
    const result = await input.target.importNativeItems(collection, {items: items.slice(i, i + 16).map(r => [r[0] as number, r[2] as Uint8Array])});
    if (!result.strict || result.live) throw new Error("native_backup_restore_items");
  }
  // Strict restore's snapshot inventory root is descending by snapshot sequence.
  for (let i = snapshots.length - 1; i >= 0; i--) {
    await input.admit("write", manifest);
    const s = snapshots[i]!;
    await input.target.importNativeSnapshot(collection, [s[0] as number, s[1] as Uint8Array, s[2] as Uint8Array, s[3] as number, s[4] === 1], expanded[i]!);
  }
  for (let i = 0; i < pages.length; i++) {
    await input.admit("write", manifest);
    const raw = pages[i]![1], ack = await input.target.restoreAuxPage(collection, raw);
    if (ack.page !== i + 1 || hex(ack.hash) !== sha(raw)) throw new Error("native_backup_restore_aux_page");
  }
  await input.admit("activate", manifest);
  const final = await input.target.importNativeItems(collection, {items: [], final: {retainedFrom: plan[4], head: plan[2], chain: plan[3]}});
  if (!final.strict || !final.live || final.head !== plan[2] || hex(final.chain) !== hex(plan[3])) throw new Error("native_backup_restore_activation");
  const head = await input.target.head(collection);
  if (head.seq !== plan[2] || hex(head.chain) !== hex(plan[3])) throw new Error("native_backup_restore_readback");
  return manifest;
}
