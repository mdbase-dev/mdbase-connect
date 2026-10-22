/**
 * Bounded original-session native Bases READ FIFO. No retry or session switch.
 * Cancelled in-flight work keeps its slot until the original response/close;
 * abandoned replies are wiped, not published or reused by the next request.
 */
import type { CborValue } from "../cbor.js";
import { mdbaseError } from "../errors.js";
type Method = "app_bases_execute_v1" | "app_bases_list_views_v1" | "app_bases_read_view_source_v1";
export class NativeBasesReads {
  private tail: Promise<void> = Promise.resolve();
  private occupied = 0;
  constructor(private readonly request: (method: Method, bytes: Uint8Array) => Promise<CborValue>) {}
  read(method: Method, bytes: Uint8Array, maxReply: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) return Promise.reject(mdbaseError("cancelled", "Bases READ cancelled"));
    if (this.occupied >= 33) return Promise.reject(mdbaseError("unavailable", "Bases read queue is full", "bases_read_backpressure"));
    const owned = bytes.slice();
    this.occupied++;
    let resolve!: (bytes: Uint8Array) => void, reject!: (error: unknown) => void;
    let settled = false;
    const result = new Promise<Uint8Array>((yes, no) => { resolve = yes; reject = no; });
    const abort = () => {
      if (settled) return;
      settled = true;
      owned.fill(0);
      reject(mdbaseError("cancelled", "Bases READ cancelled"));
    };
    signal?.addEventListener("abort", abort, {once:true});
    const run = async () => {
      try {
        if (settled) return;
        const reply = await this.request(method, owned);
        if (!(reply instanceof Uint8Array) || !reply.length || reply.length > maxReply) {
          if (reply instanceof Uint8Array) reply.fill(0);
          throw mdbaseError("internal", "native Bases response bytes exceed bound");
        }
        if (settled || signal?.aborted) { reply.fill(0); abort(); return; }
        settled = true; resolve(reply);
      } catch (error) {
        if (!settled) { settled = true; reject(error); }
      } finally {
        owned.fill(0);
        signal?.removeEventListener("abort", abort);
        this.occupied--;
      }
    };
    this.tail = this.tail.then(run, run);
    return result;
  }
}
