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

type OwnershipChange = () => Promise<CollectionSessionSnapshot | void> | CollectionSessionSnapshot | void;

export function useCollectionTransition(input: TransitionInput) {
  const latest = useRef(input);
  latest.current = input;
  const serialTail = useRef<Promise<void>>(Promise.resolve());
  const serialBusy = useRef(false);
  const explicitFlight = useRef<Promise<void> | undefined>(undefined);
  const acceptedSnapshot = useRef<string | undefined>(undefined);

  const enqueue = useCallback((task: () => Promise<void>): Promise<void> => {
    let own: Promise<void>;
    if (!serialBusy.current) {
      serialBusy.current = true;
      own = task();
    } else own = serialTail.current.then(task, task);
    const tail = own.then(() => undefined, () => undefined);
    serialTail.current = tail;
    void tail.finally(() => {
      if (serialTail.current === tail) serialBusy.current = false;
    });
    return own;
  }, []);

  const execute = useCallback((change: OwnershipChange): Promise<void> => {
    const owner = latest.current;
    owner.scope.freeze();
    owner.setFrozen(true);
    const previousOwner = owner.currentOwner();
    return (async () => {
      await owner.drain();
      await change();
      const snapshot = owner.gateway.sessionSnapshot();
      const nextOwner = snapshotOwner(snapshot);
      if (nextOwner !== previousOwner) owner.clear();
      owner.scope.changeOwner(nextOwner);
      owner.setSnapshot(snapshot);
      acceptedSnapshot.current = exactSnapshot(snapshot);
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) {
        owner.setPhase("loading");
        await owner.start();
      } else owner.setPhase("disconnected");
    })().finally(() => {
      owner.scope.unfreeze();
      owner.setFrozen(false);
    });
  }, []);

  const transition = useCallback((change: OwnershipChange): Promise<void> => {
    if (explicitFlight.current) return explicitFlight.current;
    const operation = enqueue(() => execute(change));
    explicitFlight.current = operation;
    void operation.finally(() => {
      if (explicitFlight.current === operation) explicitFlight.current = undefined;
    }).catch(() => undefined);
    return operation;
  }, [enqueue, execute]);

  const acceptSnapshot = useCallback((requested: CollectionSessionSnapshot): Promise<void> => {
    const delayed = serialBusy.current;
    return enqueue(async () => {
      const owner = latest.current;
      const authoritative = owner.gateway.sessionSnapshot();
      if (delayed && acceptedSnapshot.current === exactSnapshot(authoritative)) return;
      await execute(() => requested);
    });
  }, [enqueue, execute]);

  const authorize = useCallback((target: "selected" | "choose") =>
    transition(() => latest.current.gateway.authorize(target, { presentation: "popup" })), [transition]);
  return { transition, acceptSnapshot, authorize };
}

function exactSnapshot(snapshot: CollectionSessionSnapshot): string {
  return JSON.stringify(snapshot);
}

function snapshotOwner(snapshot: CollectionSessionSnapshot): string | undefined {
  if (snapshot.status === "ready") return snapshot.connection.collectionId;
  if (snapshot.status === "unavailable") return snapshot.collectionId;
  return undefined;
}
