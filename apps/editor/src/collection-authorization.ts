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
  currentCollectionId(): string | undefined;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  async function authorizeCollection(target: CollectionAuthorizationTarget) {
    const previous = input.gateway.sessionSnapshot();
    await input.gateway.authorize(target, { presentation: "popup" });
    const next = input.gateway.sessionSnapshot();
    const collectionChanged = next.status === "ready"
      && input.currentCollectionId() !== next.connection.collectionId;
    if (collectionChanged) input.beforeCollectionChange?.();
    input.setSessionSnapshot(next);
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
