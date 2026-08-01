import { useEffect, useMemo, useSyncExternalStore } from "react";
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
  return { controller, state };
}
