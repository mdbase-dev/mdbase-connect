import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useMdbaseMarkProgress } from "@mdbase-dev/ui/mark-activity";
import { CollectionIndexController, type CollectionIndexState } from "./collection-index-controller";
import { gatewayError } from "./gateway";
import type { CollectionGateway } from "./model";

export interface CollectionIndexRuntime {
  controller: CollectionIndexController;
  state: CollectionIndexState;
}

/** Adapts the framework-independent index controller to React's lifecycle. */
export function useCollectionIndex(gateway: CollectionGateway): CollectionIndexRuntime {
  const controller = useMemo(() => new CollectionIndexController(gateway, gatewayError), [gateway]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useEffect(() => () => { controller.reset(); }, [controller]);
  // Reading a large collection shows on the app's mark: first its notes, then their content for search.
  useMdbaseMarkProgress(state.total ? (state.structureLoading ? state.notes.length / state.total
    : state.contentIndexing ? state.contentLoaded / state.total : null) : null);
  return { controller, state };
}
