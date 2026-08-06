import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FileInventoryController } from "./file-inventory-controller";
import { gatewayError } from "./gateway";
import type { CollectionGateway } from "./model";

export function useFileInventory(gateway: CollectionGateway): {
  controller: FileInventoryController;
  state: ReturnType<FileInventoryController["getSnapshot"]>;
} {
  const controller = useMemo(() => new FileInventoryController(gateway, gatewayError), [gateway]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  useEffect(() => () => controller.reset(), [controller]);
  return { controller, state };
}
