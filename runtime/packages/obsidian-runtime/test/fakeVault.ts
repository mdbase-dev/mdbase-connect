// A fake Obsidian vault with the modelled semantics that matter here:
// in-place writes, process() serialised only against vault calls, modify events
// fired synchronously inside writes, Android-style rename (delete dest, then
// rename; a case-only rename on case-insensitive storage deletes the file).
import type { ObsAdapter, ObsApp, ObsFile, ObsStat, ObsVault } from "../src/vault/obsidianApi.js";

type Ev = "create" | "modify" | "delete" | "rename";

export class FakeVault {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);
  mtime = new Map<string, number>();
  clock = 1_000;
  insensitive: boolean;
  android: boolean;
  trashed: string[] = [];
  listeners: { ev: Ev; cb: (f: ObsFile, old?: string) => void }[] = [];
  queue: Promise<unknown> = Promise.resolve();
  /** Called between process()'s read and write (an outside writer's window). */
  betweenReadAndWrite: ((path: string) => void) | null = null;
  enabledPlugins = new Set<string>();
  syncVaultId: string | null = null;
  basePath = "/home/u/vault";

  constructor(opts: { insensitive?: boolean; android?: boolean } = {}) {
    this.insensitive = opts.insensitive ?? false;
    this.android = opts.android ?? false;
  }

  private key(p: string): string | undefined {
    if (this.files.has(p)) return p;
    if (!this.insensitive) return undefined;
    for (const k of this.files.keys()) if (k.toLowerCase() === p.toLowerCase()) return k;
    return undefined;
  }
  private fire(ev: Ev, path: string, old?: string) {
    const f = this.fileObj(path);
    for (const l of this.listeners) if (l.ev === ev) l.cb(f, old);
  }
  fileObj(path: string): ObsFile {
    const b = this.files.get(path);
    return { path, stat: b ? { size: b.length, mtime: this.mtime.get(path) ?? 0, ctime: 0 } : undefined, extension: path.split(".").pop() };
  }
  setText(p: string, s: string, outside = true) {
    const existed = this.files.has(p);
    this.files.set(p, new TextEncoder().encode(s));
    this.mtime.set(p, ++this.clock);
    if (outside) this.fire(existed ? "modify" : "create", p);
  }
  text(p: string): string | null {
    const k = this.key(p);
    return k === undefined ? null : new TextDecoder("utf-8", { ignoreBOM: true }).decode(this.files.get(k)!);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  get app(): ObsApp {
    const self = this;
    const adapter: ObsAdapter = {
      insensitive: this.insensitive && !this.android, // Android reports false
      async exists(p, sensitive) {
        if (self.dirs.has(p)) return true;
        return sensitive ? self.files.has(p) : self.key(p) !== undefined;
      },
      async stat(p): Promise<ObsStat | null> {
        if (self.dirs.has(p) || p === "/") return { type: "folder", ctime: 0, mtime: 0, size: 0 };
        const k = self.key(p);
        if (k === undefined) return null;
        return { type: "file", ctime: 0, mtime: self.mtime.get(k) ?? 0, size: self.files.get(k)!.length };
      },
      async list(p) {
        const dir = p === "/" ? "" : p;
        const under = (q: string) => (dir ? q.startsWith(dir + "/") && !q.slice(dir.length + 1).includes("/") : !q.includes("/"));
        return { files: [...self.files.keys()].filter(under), folders: [...self.dirs].filter((d) => d && under(d)) };
      },
      async read(p) {
        return self.text(p) ?? Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      },
      async readBinary(p) {
        const k = self.key(p);
        if (k === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        const b = self.files.get(k)!;
        return b.slice().buffer;
      },
      async write(p, d) {
        self.setText(p, d, false);
        self.fire("modify", p);
      },
      async writeBinary(p, d) {
        const existed = self.files.has(p);
        self.files.set(p, new Uint8Array(d));
        self.mtime.set(p, ++self.clock);
        self.fire(existed ? "modify" : "create", p);
      },
      async append(p: string, d: string) {
        const cur = self.files.get(p) ?? new Uint8Array(0);
        const add = new TextEncoder().encode(d);
        const n = new Uint8Array(cur.length + add.length);
        n.set(cur);
        n.set(add, cur.length);
        self.files.set(p, n);
      },
      async appendBinary(p, d) {
        const cur = self.files.get(p)!;
        const n = new Uint8Array(cur.length + d.byteLength);
        n.set(cur);
        n.set(new Uint8Array(d), cur.length);
        self.files.set(p, n);
      },
      process(p, fn) {
        return self.serial(async () => {
          const k = self.key(p);
          if (k === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          const cur = new TextDecoder("utf-8", { ignoreBOM: true }).decode(self.files.get(k)!); // Node fs utf8 keeps a BOM
          const next = fn(cur);
          self.betweenReadAndWrite?.(k);
          if (next !== cur) {
            self.files.set(k, new TextEncoder().encode(next));
            self.mtime.set(k, ++self.clock);
            self.fire("modify", k);
          }
          return next;
        });
      },
      async mkdir(p) {
        self.dirs.add(p);
      },
      async remove(p) {
        const k = self.key(p);
        if (k === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        self.fire("delete", k);
        self.files.delete(k);
      },
      async rename(from, to) {
        const fk = self.key(from);
        if (fk === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        const data = self.files.get(fk)!;
        if (self.android) {
          // Delete the destination, then renameTo. Case-insensitively equal → the file is gone.
          const tk = self.key(to);
          if (tk !== undefined) self.files.delete(tk);
          if (!self.files.has(fk)) return;
        }
        self.files.delete(fk);
        self.files.set(to, data);
        self.fire("rename", to, fk);
      },
      getBasePath: () => self.basePath,
    };
    const vault: ObsVault = {
      adapter,
      getFileByPath: (p) => (self.files.has(p) ? self.fileObj(p) : null),
      getAbstractFileByPath: (p) => (self.files.has(p) ? self.fileObj(p) : null),
      process: (f, fn) => adapter.process(f.path, fn),
      async create(p, d) {
        if (await adapter.exists(p)) throw new Error("File already exists.");
        self.setText(p, d, false);
        self.fire("create", p);
        return self.fileObj(p);
      },
      async createBinary(p, d) {
        if (await adapter.exists(p)) throw new Error("File already exists.");
        await adapter.writeBinary(p, d);
        return self.fileObj(p);
      },
      async rename(f, to) {
        if (await adapter.exists(to)) throw new Error("Destination file already exists!");
        await adapter.rename(f.path, to);
      },
      on(ev: Ev, cb: (f: ObsFile, old?: string) => void) {
        const ref = { ev, cb };
        self.listeners.push(ref);
        return ref;
      },
      offref(ref) {
        self.listeners = self.listeners.filter((l) => l !== ref);
      },
    } as ObsVault;
    return {
      vault,
      fileManager: {
        async trashFile(f) {
          self.trashed.push(f.path);
          await adapter.remove(f.path);
        },
      },
      internalPlugins: { getPluginById: (id) => (id === "sync" ? { enabled: true, instance: { vaultId: self.syncVaultId } } : null) },
      plugins: { enabledPlugins: self.enabledPlugins },
    };
  }
}
