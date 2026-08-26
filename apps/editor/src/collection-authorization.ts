import type { Dispatch, SetStateAction } from "react";
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
  beforeCollectionChange?(): void;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  async function authorizeCollection(target: CollectionAuthorizationTarget) {
    const previous = input.gateway.sessionSnapshot();
    await input.gateway.authorize(target, { presentation: "popup" });
    const next = input.gateway.sessionSnapshot();
    input.setSessionSnapshot(next);
    const collectionChanged = previous.status === "ready"
      && next.status === "ready"
      && previous.connection.collectionId !== next.connection.collectionId;
    if (collectionChanged) input.beforeCollectionChange?.();
    if (
      next.status === "ready"
      && missingCoreCapabilities(next.connection).length === 0
      && (input.phase !== "ready" || previous.status !== "ready" || collectionChanged)
    ) {
      await input.start();
    }
  }

  return { authorizeCollection };
}
