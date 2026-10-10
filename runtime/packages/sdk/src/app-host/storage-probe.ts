/** OPFS capability probe, NOT SQLite/physical-durability qualification.
 * Run in the dedicated Worker which will also own runtime.wasm and sqlite-wasm.
 * It touches only a random scratch file under the reserved probe directory. */
export interface ProbeSyncHandle {
  write(bytes: Uint8Array, options: { at: number }): number;
  read(bytes: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}
export interface ProbeDirectory {
  getDirectoryHandle(name: string, options: { create: true }): Promise<ProbeDirectory>;
  getFileHandle(name: string, options: { create: true }): Promise<{
    createSyncAccessHandle?(): Promise<ProbeSyncHandle>;
  }>;
  removeEntry(name: string): Promise<void>;
}
export interface AppStorageProbeEnvironment {
  /** Must be established by the trusted host, not an application grant. */
  worker: boolean;
  storage?: { getDirectory?(): Promise<ProbeDirectory> };
  /** CSPRNG-generated UUID supplied by the host (crypto.randomUUID). */
  randomUUID(): string;
}
export type AppStorageProbe =
  | { supported: true; backend: "opfs_sahpool_candidate"; crashDurability: "unqualified"; eviction: "possible" }
  | { supported: false; reason: "worker_required" | "opfs_unavailable" | "sync_handle_unavailable" | "probe_failed" | "cleanup_failed" };

/** Success proves only that synchronous access/flush/readback are available now.
 * It does not open an app store, return IndexDurability::Durable or certify saved
 * edits. Errors deliberately omit browser exception messages/storage paths. */
export async function probeAppStorage(env: AppStorageProbeEnvironment): Promise<AppStorageProbe> {
  if (!env.worker) return { supported: false, reason: "worker_required" };
  if (!env.storage?.getDirectory) return { supported: false, reason: "opfs_unavailable" };
  let directory: ProbeDirectory | undefined;
  let file: string | undefined;
  let created = false;
  let handle: ProbeSyncHandle | undefined;
  let result: AppStorageProbe = { supported: false, reason: "probe_failed" };
  try {
    const id = env.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return result;
    }
    file = id.toLowerCase();
    directory = await (await env.storage.getDirectory()).getDirectoryHandle(".mdbase-app-probes", { create: true });
    const entry = await directory.getFileHandle(file, { create: true });
    created = true;
    if (!entry.createSyncAccessHandle) {
      result = { supported: false, reason: "sync_handle_unavailable" };
    } else {
      handle = await entry.createSyncAccessHandle();
      const bytes = new Uint8Array([0x6d, 0x64, 0x62, 0x6e]);
      const read = new Uint8Array(bytes.length);
      if (handle.write(bytes, { at: 0 }) !== bytes.length) throw new Error("short probe write");
      handle.flush();
      if (handle.read(read, { at: 0 }) !== bytes.length || read.some((b, i) => b !== bytes[i])) {
        throw new Error("probe readback failed");
      }
      result = { supported: true, backend: "opfs_sahpool_candidate", crashDurability: "unqualified", eviction: "possible" };
    }
  } catch {
    result = { supported: false, reason: "probe_failed" };
  } finally {
    let closed = true;
    try {
      handle?.close();
    } catch {
      closed = false;
      result = { supported: false, reason: "cleanup_failed" };
    }
    // Do not remove an entry while its close outcome is uncertain.
    if (created && closed && directory && file) {
      try {
        await directory.removeEntry(file);
      } catch {
        result = { supported: false, reason: "cleanup_failed" };
      }
    }
  }
  return result;
}
