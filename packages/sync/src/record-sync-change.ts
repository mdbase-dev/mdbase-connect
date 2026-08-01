import type { JsonObject, SyncChange } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";

export type RecordSyncChange<Frontmatter extends JsonObject = JsonObject> = Extract<
  SyncChange<Frontmatter>,
  { type: "put" | "remove" }
>;

/**
 * Transitional fail-closed boundary while file materialization is wired into
 * each replica implementation. A replica must never advance past file events
 * it did not durably apply.
 */
export function assertRecordSyncChanges<Frontmatter extends JsonObject>(
  events: Array<SyncChange<Frontmatter>>
): asserts events is Array<RecordSyncChange<Frontmatter>> {
  if (events.some((event) => event.type === "file_put" || event.type === "file_remove")) {
    throw new SyncError(
      "file_sync_unsupported",
      "This replica cannot materialize collection file changes yet. Upgrade it before continuing sync."
    );
  }
}

export function assertRecordSyncChange<Frontmatter extends JsonObject>(
  event: SyncChange<Frontmatter>
): asserts event is RecordSyncChange<Frontmatter> {
  assertRecordSyncChanges([event]);
}
