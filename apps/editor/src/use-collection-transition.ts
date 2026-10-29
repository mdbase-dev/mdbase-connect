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
  const authorizationFlight = useRef<Promise<void> | undefined>(undefined);
  const acceptedSnapshot = useRef<{ gateway: CollectionGateway; snapshot: CollectionSessionSnapshot } | undefined>(undefined);

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
      acceptedSnapshot.current = { gateway: owner.gateway, snapshot };
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) {
        owner.setPhase("loading");
        await owner.start();
      } else owner.setPhase("disconnected");
    })().finally(() => {
      owner.scope.unfreeze();
      owner.setFrozen(false);
    });
  }, []);

  const transition = useCallback((change: OwnershipChange): Promise<void> =>
    enqueue(() => execute(change)), [enqueue, execute]);

  const acceptSnapshot = useCallback((requested: CollectionSessionSnapshot): Promise<void> => {
    const delayed = serialBusy.current;
    return enqueue(async () => {
      const owner = latest.current;
      const authoritative = owner.gateway.sessionSnapshot();
      const accepted = acceptedSnapshot.current;
      if (delayed && accepted?.gateway === owner.gateway && exactSnapshot(accepted.snapshot) === exactSnapshot(authoritative)) return;
      // A live role update belongs to this open scope. Do not drain a refused
      // draft, retire its operation token, or reload the workspace to display it.
      if (accepted?.gateway === owner.gateway && accepted.snapshot.status === "ready" && authoritative.status === "ready"
        && accepted.snapshot.connection.role !== undefined && authoritative.connection.role !== undefined
        && accepted.snapshot.connection.collectionId === authoritative.connection.collectionId
        && owner.currentOwner() === authoritative.connection.collectionId) {
        owner.setSnapshot(authoritative);
        acceptedSnapshot.current = { gateway: owner.gateway, snapshot: authoritative };
        return;
      }
      await execute(() => requested);
    });
  }, [enqueue, execute]);

  const authorize = useCallback((target: "selected" | "choose") => {
    if (authorizationFlight.current) return authorizationFlight.current;
    const operation = transition(() => latest.current.gateway.authorize(target, { presentation: "popup" }));
    authorizationFlight.current = operation;
    void operation.finally(() => {
      if (authorizationFlight.current === operation) authorizationFlight.current = undefined;
    }).catch(() => undefined);
    return operation;
  }, [transition]);
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
