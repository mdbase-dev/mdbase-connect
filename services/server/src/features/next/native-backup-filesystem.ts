// Owner-only, create-only ordinary files: server admin stage and offline drill.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { NativeBackupStore } from "./native-backup-archive.js";
import { nativeArchivePath, type NativeArchiveFiles } from "./native-backup-verifier.js";

async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("native_backup_private_directory");
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r"); try {await file.sync();} finally {await file.close();}
}
const admitted = (name: string) => name === "coverage.json" || nativeArchivePath(name);
export async function readPrivateBackupFile(path: string, max: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size < 1 || stat.size > max) throw new Error("native_backup_private_file");
    // A bounded allocation/read; do not trust size metadata if a file grows.
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {const part = await file.read(bytes, used, bytes.length - used, null); if (!part.bytesRead) break; used += part.bytesRead;}
    if (used !== stat.size) throw new Error("native_backup_file_changed");
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("native_backup_file_changed");
    return bytes.subarray(0, used);
  } finally {await file.close();}
}
export async function filesystemBackupStore(root: string): Promise<NativeBackupStore> {
  if (!isAbsolute(root)) throw new Error("native_backup_absolute_stage_required");
  await privateDirectory(root);
  const parents = async (name: string, create: boolean) => {
    if (!admitted(name)) throw new Error("native_backup_stage_key");
    await privateDirectory(root);
    let path = root;
    for (const segment of name.split("/").slice(0,-1)) {
      path = join(path, segment);
      if (create) try {await mkdir(path, {mode:0o700});} catch (error) {if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;}
      await privateDirectory(path);
    }
  };
  return {
    async putIfAbsent(name, bytes) {
      await parents(name, true);
      const path = join(root,name), pending = join(dirname(path),`.native-backup-${randomUUID()}.pending`);
      const file = await open(pending,"wx",0o600);
      try {
        await file.writeFile(bytes); await file.sync(); await file.close();
        // Exclusive atomic publication: readers can never see partial coverage.
        await link(pending,path);
      } finally {await file.close(); await unlink(pending);}
      await syncDirectory(dirname(path));
      // Persist newly created directory entries as well as the leaf.
      if (name.startsWith("cut/")) await syncDirectory(join(root,"cut"));
      await syncDirectory(root);
    },
    async read(name, maxBytes) {await parents(name, false); return readPrivateBackupFile(join(root,name),maxBytes);},
  };
}
/** Exact existing #686 cut inventory. Trust/operation metadata stay OUTSIDE the
 * archive; unexpected files, pending publication and links fail closed. */
export async function readNativeBackupStage(root: string): Promise<NativeArchiveFiles> {
  const store = await filesystemBackupStore(root), files = new Map<string,Uint8Array>();
  const allowedRoot = new Set(["operation.json","capture-context.cbor","completion.cbor","cut","trust.cbor"]);
  for (const entry of await readdir(root)) if (!allowedRoot.has(entry)) throw new Error("native_backup_stage_extra");
  for (const name of ["completion.cbor","capture-context.cbor","cut/header.cbor","cut/finish.cbor"]) files.set(name,await store.read(name,65536));
  await privateDirectory(join(root,"cut"));
  if ((await readdir(join(root,"cut"))).sort().join(",") !== "finish.cbor,header.cbor,objects,pages") throw new Error("native_backup_cut_layout");
  let total = [...files.values()].reduce((n,b) => n+b.length,0);
  for (const directory of ["pages","objects"]) {
    await privateDirectory(join(root,"cut",directory));
    const names = await readdir(join(root,"cut",directory));
    if (names.length > (directory === "pages" ? 1024 : 4096)) throw new Error("native_backup_stage_count");
    for (const name of names.sort()) {
      const key = `cut/${directory}/${name}`, max = directory === "pages" ? 4*1024*1024 : 9*1024*1024;
      const raw = await store.read(key,max); total += raw.length;
      if (total > 64*1024*1024+256*1024) throw new Error("native_backup_stage_bytes");
      files.set(key,raw);
    }
  }
  return files;
}
