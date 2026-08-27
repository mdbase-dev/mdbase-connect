import { useRef, type Dispatch, type SetStateAction } from "react";
import { missingCoreCapabilities } from "./gateway";
import type {
  CollectionAuthorizationTarget,
  CollectionGateway,
  CollectionSessionSnapshot
} from "./model";

export function useCollectionAuthorization(input: {
  gateway: CollectionGateway;
  phase: "starting" | "disconnected" | "loading" | "ready";
  start(): Promise<void>;
  beforeAuthorization?(): Promise<void>;
  finishAuthorization?(): void;
  beforeCollectionChange?(): void;
  currentCollectionId(): string | undefined;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  const flight = useRef<Promise<void> | undefined>(undefined);

  function authorizeCollection(target: CollectionAuthorizationTarget): Promise<void> {
    if (flight.current) return flight.current;
    const operation = (async () => {
      try {
        await input.beforeAuthorization?.();
        await input.gateway.authorize(target, { presentation: "popup" });
        const next = input.gateway.sessionSnapshot();
        const collectionChanged = next.status === "ready"
          && input.currentCollectionId() !== next.connection.collectionId;
        if (collectionChanged) input.beforeCollectionChange?.();
        input.setSessionSnapshot(next);
        if (
          next.status === "ready"
          && missingCoreCapabilities(next.connection).length === 0
          && (input.phase !== "ready" || collectionChanged)
        ) await input.start();
      } finally {
        input.finishAuthorization?.();
      }
    })();
    flight.current = operation;
    void operation.finally(() => { if (flight.current === operation) flight.current = undefined; }).catch(() => undefined);
    return operation;
  }

  return { authorizeCollection };
}
