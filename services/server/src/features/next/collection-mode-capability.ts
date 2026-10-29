// A historical advertisement gates arming. Only current-session/request
// capabilities gate minting; the historical bit is never a mint permission.
import type { DatabaseQueryable } from "../../database-types.js";
import { CreateError } from "./bootstrap-common.js";
import { LOG_TOKEN_LIFETIME_MS } from "./log-service-client.js";

export const MODE_SWITCH_CAPABILITY = "collection_mode_switch_v1";
export const modeCapabilitySchema = { type: "array", maxItems: 64, items: { type: "string", maxLength: 80 } };
export const switchAware = (capabilities: unknown): boolean => Array.isArray(capabilities) && capabilities.includes(MODE_SWITCH_CAPABILITY);

export async function advertiseModeCapability(db: DatabaseQueryable, device: string, capabilities: unknown): Promise<void> {
  if (switchAware(capabilities)) await db.query("UPDATE next_devices SET mode_switch_advertised=true WHERE id=$1 AND NOT mode_switch_advertised", [device]);
}

/** Hold the collection share lock through mint, serializing with floor raising. */
export async function requireModeMintCapability(db: DatabaseQueryable, collection: string, capabilities: unknown): Promise<void> {
  const row = (await db.query<{ mode_floor_raised_at: Date | null }>("SELECT mode_floor_raised_at FROM next_collections WHERE collection_id=$1 FOR SHARE", [collection])).rows[0];
  if (row?.mode_floor_raised_at && !switchAware(capabilities)) throw new CreateError(409, "mode_update_required");
}

export class ModeDevicesNeedUpdate extends CreateError {
  constructor(readonly devices: string[]) { super(409, "mode_devices_need_update"); }
}

/** `members` comes from the signed native preflight at its applied prefix.
 * Raise once, then drain all pre-floor tokens before publishing any switch. */
export async function armModeFloor(db: DatabaseQueryable, collection: string, members: readonly string[], now: number): Promise<number> {
  if (!members.length) throw new CreateError(409, "keyed_owner_required");
  const rows = (await db.query<{ id: string }>("SELECT id FROM next_devices WHERE id=ANY($1::uuid[]) AND mode_switch_advertised", [members])).rows;
  const supported = new Set(rows.map(row => row.id));
  const missing = members.filter(id => !supported.has(id));
  if (missing.length) throw new ModeDevicesNeedUpdate(missing);
  const row = (await db.query<{ mode_floor_raised_at: Date }>(`UPDATE next_collections SET mode_floor_raised_at=COALESCE(mode_floor_raised_at,$2)
    WHERE collection_id=$1 RETURNING mode_floor_raised_at`, [collection, new Date(now)])).rows[0];
  if (!row) throw new CreateError(409, "not_current");
  return row.mode_floor_raised_at.getTime() + LOG_TOKEN_LIFETIME_MS;
}
