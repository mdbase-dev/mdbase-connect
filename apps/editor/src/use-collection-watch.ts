import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { CollectionChange } from "@mdbase-dev/connect";
import type { ConnectionState } from "./app-state-types";
import { isFileChange, reconcileFileChange } from "./file-change-reconciliation";
import type { FileAssetStore } from "./file-asset-store";
import type { FileInventoryController } from "./file-inventory-controller";
import { gatewayError } from "./gateway";
import type { CollectionIndexController } from "./collection-index-controller";
import type { CollectionGateway } from "./model";
import { reconcileStructuralChanges } from "./structural-change-reconciliation";

export function useCollectionWatch(input: {
  phase: string;
  connectionRetry: number;
  gateway: CollectionGateway;
  index: CollectionIndexController;
  files: FileInventoryController;
  assets: FileAssetStore;
  loadIndex(): Promise<void>;
  refreshChangedNote(path: string): Promise<void>;
  refreshDescription(): Promise<unknown>;
  refreshAfterConnectionGap(): Promise<void>;
  setConnectionState: Dispatch<SetStateAction<ConnectionState>>;
  setConnectionIssue: Dispatch<SetStateAction<string | undefined>>;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
}) {
  useEffect(() => {
    if (input.phase !== "ready") return;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    let resetHandled = false;
    const changedPaths = new Set<string>();
    const structuralChanges: CollectionChange[] = [];
    let filesChanged = false;
    let typesChanged = false;
    let indexChanged = false;
    const handleChange = (change?: CollectionChange) => {
      if (change && isFileChange(change)) {
        filesChanged = true;
        reconcileFileChange(change, input.files, input.assets);
      } else if (change?.type === "mdbase.record.modified" && typeof change.payload.path === "string") changedPaths.add(change.payload.path);
      else if (change?.type === "mdbase.type.changed") {
        typesChanged = true;
        indexChanged = true;
      } else if (change?.type === "mdbase.record.created" || change?.type === "mdbase.record.deleted" || change?.type === "mdbase.record.renamed") structuralChanges.push(change);
      else indexChanged = true;

      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const paths = [...changedPaths];
        changedPaths.clear();
        const shouldRefreshTypes = typesChanged;
        typesChanged = false;
        const currentPaths = new Set(input.index.getSnapshot().notes.map((note) => note.path));
        const structural = reconcileStructuralChanges(structuralChanges, currentPaths);
        const shouldRefreshIndex = indexChanged || structural.requiresRefresh;
        structuralChanges.length = 0;
        indexChanged = false;
        const shouldRefreshFiles = filesChanged;
        filesChanged = false;
        if (shouldRefreshIndex) void input.loadIndex().catch((error) => {
          if (!controller.signal.aborted) input.setConnectionIssue(gatewayError(error));
        });
        else for (const path of structural.deletedPathsToConfirm) {
          void input.refreshChangedNote(path).catch(() => input.loadIndex().catch((error) => {
            if (!controller.signal.aborted) input.setConnectionIssue(gatewayError(error));
          }));
        }
        for (const path of paths) void input.refreshChangedNote(path).catch((error) => {
          if (!controller.signal.aborted) input.setNotice(gatewayError(error));
        });
        if (shouldRefreshTypes) void input.refreshDescription();
        if (shouldRefreshFiles) void input.files.reload().catch(() => undefined);
      }, 180);
    };
    void input.gateway.watch(handleChange, controller.signal, (status) => {
      if (controller.signal.aborted) return;
      if (status.state === "reconnecting") {
        input.setConnectionState("reconnecting");
        input.setConnectionIssue(status.problem.message);
      } else if (status.state === "connected") {
        input.setConnectionState("connected");
        input.setConnectionIssue(undefined);
      } else if (status.state === "reset_required") {
        resetHandled = true;
        void input.refreshAfterConnectionGap();
      }
    }).catch((error) => {
      if (!controller.signal.aborted && !resetHandled) {
        input.setConnectionState("reconnecting");
        input.setConnectionIssue(gatewayError(error));
      }
    });
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
    };
  }, [input.assets, input.connectionRetry, input.files, input.gateway, input.index, input.loadIndex, input.phase, input.refreshAfterConnectionGap, input.refreshChangedNote, input.refreshDescription, input.setConnectionIssue, input.setConnectionState, input.setNotice]);
}
