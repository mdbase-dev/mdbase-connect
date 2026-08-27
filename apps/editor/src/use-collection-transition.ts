import { useRef, type Dispatch, type SetStateAction } from "react";
import { missingCoreCapabilities } from "./gateway";
import type { AppPhase } from "./app-state-types";
import type { CollectionGateway, CollectionSessionSnapshot } from "./model";
import type { CollectionMutationScope } from "./collection-mutation-scope";

export function useCollectionTransition(input: {
  gateway: CollectionGateway;
  scope: CollectionMutationScope;
  currentOwner(): string | undefined;
  drain(): Promise<void>;
  clear(): void;
  start(): Promise<void>;
  setFrozen(value: boolean): void;
  setPhase: Dispatch<SetStateAction<AppPhase>>;
  setSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  const flight = useRef<Promise<void> | undefined>(undefined);

  function transition(change: () => Promise<void> | void): Promise<void> {
    if (flight.current) return flight.current;
    input.scope.freeze();
    input.setFrozen(true);
    const previousOwner = input.currentOwner();
    const operation = (async () => {
      await input.drain();
      await change();
      const snapshot = input.gateway.sessionSnapshot();
      const nextOwner = snapshot.status === "ready" ? snapshot.connection.collectionId : undefined;
      if (nextOwner !== previousOwner) input.clear();
      input.scope.changeOwner(nextOwner);
      input.setSnapshot(snapshot);
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) {
        input.setPhase("loading");
        await input.start();
      } else input.setPhase("disconnected");
    })().finally(() => {
      if (flight.current === operation) flight.current = undefined;
      input.scope.unfreeze();
      input.setFrozen(false);
    });
    flight.current = operation;
    return operation;
  }

  return {
    transition,
    authorize: (target: "selected" | "choose") =>
      transition(() => input.gateway.authorize(target, { presentation: "popup" }))
  };
}
