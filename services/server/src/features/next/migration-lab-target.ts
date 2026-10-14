// LAB runner composition of the existing authenticated SHADOW target creator.
// No new bootstrap, custody exemption, target selector, serving or H1 authority.
import { z } from "zod";
import { migrationUuid } from "../../hosted-provider-replies.js";
import { RolloutRefused } from "./migration-rollout.js";

const unavailable = (): never => { throw new RolloutRefused("migration_target_unavailable", "No verified SHADOW custody target; Worker run not dispatched.", 503); };
const metadata = z.object({
  collection_id: migrationUuid, owner_account: migrationUuid, state: z.literal("cloud-copy"),
  service_devices: z.array(z.object({ kind: z.enum(["hosted", "escrow"]), device_id: migrationUuid }).passthrough()).length(2)
}).passthrough();

export function labTargetBootstrap(config: { environment?: string; url: string; token: string; account: string }, fetchImpl: typeof fetch = fetch) {
  if (config.environment !== "lab") throw new RolloutRefused("lab_only", "LAB target bootstrap is unavailable.", 503);
  let origin: URL;
  try { origin = new URL(config.url); } catch { return unavailable(); }
  if (origin.origin !== "https://connect-lab.mdbase.dev" || origin.href !== "https://connect-lab.mdbase.dev/"
      || config.token.length < 32 || !migrationUuid.safeParse(config.account).success) return unavailable();
  return async (collection: string): Promise<void> => {
    if (!migrationUuid.safeParse(collection).success) return unavailable();
    let response: Response;
    try {
      response = await fetchImpl(new URL(`/internal/v1/next/migration/collections/${collection}/target`, origin), {
        method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: "{}", redirect: "error", signal: AbortSignal.timeout(30_000)
      });
    } catch { return unavailable(); }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* No raw provider error. */ } return unavailable(); }
    const reader = response.body?.getReader();
    if (!reader) return unavailable();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        bytes += item.value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); return unavailable(); }
        chunks.push(item.value);
      }
      const result = metadata.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!result.success || result.data.collection_id !== collection || result.data.owner_account !== config.account
          || new Set(result.data.service_devices.map(device => device.kind)).size !== 2) return unavailable();
    } catch { return unavailable(); }
  };
}
