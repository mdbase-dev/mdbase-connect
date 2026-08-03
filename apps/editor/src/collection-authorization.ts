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
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  async function authorizeCollection(target: CollectionAuthorizationTarget) {
    const previous = input.gateway.sessionSnapshot();
    await input.gateway.authorize(target);
    const next = input.gateway.sessionSnapshot();
    input.setSessionSnapshot(next);
    if (
      next.status === "ready"
      && missingCoreCapabilities(next.connection).length === 0
      && (
        input.phase !== "ready"
        || previous.status !== "ready"
        || previous.connection.collectionId !== next.connection.collectionId
      )
    ) {
      await input.start();
    }
  }

  return { authorizeCollection };
}
