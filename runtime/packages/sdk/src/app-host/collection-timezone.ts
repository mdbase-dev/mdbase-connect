import { MdbaseClient } from "../client.js";
import { isMdbaseError, mdbaseError } from "../errors.js";
import { inProcessConnector } from "../transport/inprocess.js";
import type { AppWasmRuntime } from "./wasm-runtime.js";

export function isCollectionTimezoneName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 &&
    /^(?:UTC|[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)+)$/.test(value);
}

export function collectionTimezone(timezone?: string): string | null {
  try {
    const id = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!isCollectionTimezoneName(id)) return null;
    new Intl.DateTimeFormat("en", { timeZone: id });
    return id;
  } catch {
    return null;
  }
}


/** An unsynced identity pins the zone before SQL is opened. Reuse the same
 * mutation on recovery, and keep any config the user has already created. */
export async function initializeAppCollectionConfig(
  runtime: AppWasmRuntime, collection: string, timezone: string | null, signal: AbortSignal,
): Promise<void> {
  const client = await MdbaseClient.connect({
    app: { name: "mdbase-collection-initialization", version: "1" },
    connector: inProcessConnector(runtime, { collection }),
    reconnect: false, signal,
  });
  try {
    const existing = await client.resources.get("mdbase.yaml", { signal }).catch(error => {
      if (!isMdbaseError(error, "not_found")) throw error;
      return null;
    });
    if (existing?.state === "confirmed") return;

    const receipt = await client.receipt(collection, { signal }).catch(error => {
      if (!isMdbaseError(error, "not_found")) throw error;
      return null;
    });
    if (!receipt && !existing) {
      const config = 'spec_version: "0.3.0"\n' + (timezone ? `settings:\n  timezone: "${timezone}"\n` : "");
      const write = await client.resources.put("mdbase.yaml", config, {
        mustNotExist: true, mutationId: collection, conflictMode: "reject", signal,
      });
      runtime.tick();
      await write.confirmed;
    } else if (receipt && receipt.state !== "confirmed") {
      runtime.tick();
      if ((await client.awaitReceipt(collection, { signal })).state !== "confirmed") {
        throw mdbaseError("unavailable", "Unable to confirm the original collection configuration.");
      }
    }
  } finally {
    client.close();
  }
}
