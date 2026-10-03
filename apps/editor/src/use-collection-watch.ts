import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { ConnectionState } from "./app-state-types";
import { isFileChange, reconcileFileChange } from "./file-change-reconciliation";
import type { FileAssetStore } from "./file-asset-store";
import type { FileInventoryController } from "./file-inventory-controller";
import { gatewayError } from "./gateway";
import type { CollectionIndexController } from "./collection-index-controller";

/** App-owned effects only: file previews, schemas and open editing sessions.
 * Query membership, rereads and reset/reconnect are owned by observe(). */
export function useCollectionWatch(input: {
  phase: string;
  index: CollectionIndexController;
  files: FileInventoryController;
  assets: FileAssetStore;
  refreshCachedNote(path: string, revision?: string): Promise<void>;
  refreshDescription(): Promise<unknown>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setConnectionIssue: Dispatch<SetStateAction<string | undefined>>;
  setNotice: (message?: string, tone?: "info" | "success" | "error") => void;
}) {
  useEffect(() => {
    if (input.phase !== "ready") return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const paths = new Map<string, string | undefined>();
    let files = false, description = false;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const report = (error: unknown) => { if (active) input.setNotice(gatewayError(error)); };
        if (files) { files = false; void input.files.reload().catch(report); }
        if (description) { description = false; void input.refreshDescription().catch(report); }
        for (const [path, revision] of paths) void input.refreshCachedNote(path, revision).catch(report);
        paths.clear();
      }, 50);
    };
    let lastStatus: unknown;
    const publishStatus = () => {
      const status = input.index.getWatchStatus();
      if (!status || status === lastStatus) return;
      lastStatus = status;
      if (status.state === "reconnecting") {
        input.setConnectionState("reconnecting"); input.setConnectionIssue(status.problem.message);
      } else if (status.state === "connected") {
        input.setConnectionState("connected"); input.setConnectionIssue(undefined);
      } else if (status.state === "closed" && input.index.getSnapshot().structureError) {
        input.setConnectionState("stopped"); input.setConnectionIssue(input.index.getSnapshot().structureError);
      } else if (status.state === "reset_required") { files = description = true; schedule(); }
    };
    const statusChanged = input.index.subscribe(publishStatus);
    publishStatus();
    const changed = input.index.subscribeChanges(change => {
      if (isFileChange(change)) { reconcileFileChange(change, input.files, input.assets); files = true; }
      else if (change.kind === "record.renamed") { paths.set(change.from, undefined); paths.set(change.to, change.revision); }
      else if (change.kind === "record.created" || change.kind === "record.updated") paths.set(change.path, change.revision);
      else if (change.kind === "record.deleted") paths.set(change.path, undefined);
      else { description = true; files = true; }
      schedule();
    });
    return () => { active = false; clearTimeout(timer); statusChanged(); changed(); };
  }, [input.phase, input.index, input.files, input.assets, input.refreshCachedNote, input.refreshDescription, input.setConnectionState, input.setConnectionIssue, input.setNotice]);
}
