import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { missingCoreCapabilities } from "./gateway";
import type { AppPhase } from "./app-state-types";
import type { CollectionGateway, CollectionSessionSnapshot } from "./model";
import type { CollectionMutationScope } from "./collection-mutation-scope";

interface TransitionInput {
  gateway: CollectionGateway;
  scope: CollectionMutationScope;
  currentOwner(): string | undefined;
  drain(): Promise<void>;
  clear(): void;
  start(): Promise<void>;
  setFrozen(value: boolean): void;
  setPhase: Dispatch<SetStateAction<AppPhase>>;
  setSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}

export function useCollectionTransition(input: TransitionInput) {
  const latest = useRef(input);
  latest.current = input;
  const flight = useRef<Promise<void> | undefined>(undefined);
  const queued = useRef<(() => Promise<CollectionSessionSnapshot | null | void> | CollectionSessionSnapshot | null | void) | undefined>(undefined);
  const queuedFlight = useRef<Promise<void> | undefined>(undefined);
  const acceptedSignature = useRef<string | undefined>(undefined);

  const transition: (change: () => Promise<CollectionSessionSnapshot | null | void> | CollectionSessionSnapshot | null | void) => Promise<void> = useCallback((change) => {
    if (flight.current) {
      queued.current = change;
      if (!queuedFlight.current) queuedFlight.current = flight.current.then(async () => {
        const next = queued.current;
        queued.current = undefined;
        if (next) await transition(next);
      }, (error: unknown) => {
        queued.current = undefined;
        throw error;
      }).finally(() => { queuedFlight.current = undefined; });
      return queuedFlight.current;
    }
    const owner = latest.current;
    owner.scope.freeze();
    owner.setFrozen(true);
    const previousOwner = owner.currentOwner();
    const operation = (async () => {
      await owner.drain();
      const accepted = await change();
      if (accepted === null) return;
      const snapshot = accepted ?? owner.gateway.sessionSnapshot();
      const nextOwner = snapshotOwner(snapshot);
      if (nextOwner !== previousOwner) owner.clear();
      owner.scope.changeOwner(nextOwner);
      owner.setSnapshot(snapshot);
      acceptedSignature.current = snapshotSignature(snapshot);
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) {
        owner.setPhase("loading");
        await owner.start();
      } else owner.setPhase("disconnected");
    })().finally(() => {
      if (flight.current === operation) flight.current = undefined;
      owner.scope.unfreeze();
      owner.setFrozen(false);
    });
    flight.current = operation;
    return operation;
  }, []);

  const acceptSnapshot = useCallback((snapshot: CollectionSessionSnapshot) => {
    const queuedBehindFlight = Boolean(flight.current);
    return transition(() => queuedBehindFlight && acceptedSignature.current === snapshotSignature(snapshot) ? null : snapshot);
  }, [transition]);
  const authorize = useCallback((target: "selected" | "choose") =>
    transition(() => latest.current.gateway.authorize(target, { presentation: "popup" })), [transition]);
  return { transition, acceptSnapshot, authorize };
}

function snapshotSignature(snapshot: CollectionSessionSnapshot): string {
  return `${snapshot.status}:${snapshotOwner(snapshot) ?? ""}`;
}

function snapshotOwner(snapshot: CollectionSessionSnapshot): string | undefined {
  if (snapshot.status === "ready") return snapshot.connection.collectionId;
  if (snapshot.status === "unavailable") return snapshot.collectionId;
  return undefined;
}
