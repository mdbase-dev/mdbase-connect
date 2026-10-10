/**
 * Main-thread side of the index Worker (`worker.ts`): spawn it from bundled code
 * (a Blob URL works in Obsidian on desktop and Android, Worker hosting) and call it.
 */

import { IndexError, type Batch, type IndexInfo, type StmtResult } from "./sqliteIndex.js";

export class IndexWorkerClient {
  private next = 1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly waiting = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private readonly url: string;
  readonly worker: Worker;

  /** @param code the bundled worker script (IIFE) */
  constructor(code: string) {
    this.url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    this.worker = new Worker(this.url);
    this.worker.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { id: number; ok: boolean; value?: unknown; error?: { kind: IndexError["kind"]; detail: string; stmt: number | null } };
      const w = this.waiting.get(d.id);
      if (!w) return;
      this.waiting.delete(d.id);
      if (d.ok) w.resolve(d.value);
      else w.reject(new IndexError(d.error!.kind, d.error!.detail, d.error!.stmt));
    };
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }

  open(collectionId: string, sqliteWasm: ArrayBuffer, wipe = false): Promise<IndexInfo> {
    return this.call({ op: "open", collectionId, wasm: sqliteWasm, wipe });
  }
  run(batch: Batch): Promise<StmtResult[]> {
    return this.call({ op: "run", batch });
  }
  close(): Promise<void> {
    return this.call({ op: "close" });
  }
  /** Close the database, then the Worker (its access handles go with it). */
  async terminate(): Promise<void> {
    try {
      await this.close();
    } finally {
      this.worker.terminate();
      URL.revokeObjectURL(this.url);
    }
  }
}
