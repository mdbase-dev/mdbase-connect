import { describe, expect, it } from "vitest";
import type { SyncChange } from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { assertRecordSyncChanges } from "./record-sync-change.js";

describe("record-only replica compatibility boundary", () => {
  it("accepts record changes", () => {
    const changes: SyncChange[] = [{
      sequence: 1,
      type: "remove",
      record_id: "01911111-1111-7111-8111-111111111111",
      previous_path: "task.md",
      revision: "record:2"
    }];
    expect(() => assertRecordSyncChanges(changes)).not.toThrow();
  });

  it("fails before a record-only replica can checkpoint a file change", () => {
    const changes: SyncChange[] = [{
      sequence: 2,
      type: "file_remove",
      file_id: "01922222-2222-7222-8222-222222222222",
      previous_path: "assets/photo.jpg",
      revision: "file:2"
    }];
    expect(() => assertRecordSyncChanges(changes)).toThrowError(
      expect.objectContaining<Partial<SyncError>>({ code: "file_sync_unsupported" })
    );
  });
});
