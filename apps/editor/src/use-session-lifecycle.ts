import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { AppPhase } from "./app-state-types";
import { gatewayError, missingCoreCapabilities } from "./gateway";
import type { CollectionGateway, CollectionSessionSnapshot } from "./model";

export function useSessionLifecycle({ gateway, start, setSessionSnapshot, setNotice, setPhase, collectionEpoch }: {
  gateway: CollectionGateway;
  start: () => Promise<void>;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
  setNotice: (message?: string, tone?: "info" | "success" | "error") => void
  setPhase: Dispatch<SetStateAction<AppPhase>>;
  collectionEpoch: MutableRefObject<number>;
}) {
  const requestGeneration = useRef(0);
  const retrySessionStart = useCallback(async () => {
    const epoch = collectionEpoch.current;
    const generation = ++requestGeneration.current;
    try {
      const snapshot = await gateway.startSession();
      if (epoch !== collectionEpoch.current || generation !== requestGeneration.current) return;
      setSessionSnapshot(snapshot);
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) await start();
      else {
        setNotice(snapshot.status === "start_failed" ? snapshot.problem.message : undefined);
        setPhase("disconnected");
      }
    } catch (error) {
      if (epoch !== collectionEpoch.current || generation !== requestGeneration.current) return;
      setNotice(gatewayError(error));
      setPhase("disconnected");
    }
  }, [collectionEpoch, gateway, setNotice, setPhase, setSessionSnapshot, start]);

  useEffect(() => {
    let alive = true;
    let stopSessionChanges: (() => void) | undefined;
    const generation = ++requestGeneration.current;
    void (async () => {
      try {
        const initial = await gateway.startSession();
        if (!alive || generation !== requestGeneration.current) return;
        setSessionSnapshot(initial);
        if (initial.status === "start_failed") setNotice(initial.problem.message);
        if (initial.status === "destroyed") setNotice("This editor session has been closed.");
        stopSessionChanges = gateway.onSessionChange((snapshot) => {
          if (!alive) return;
          const current = gateway.sessionSnapshot();
          if (!sameAuthoritativeSnapshot(snapshot, current)) return;
          setSessionSnapshot(snapshot);
          if (snapshot.status !== "ready") setPhase((current) => current === "starting" ? current : "disconnected");
        });
        const snapshot = gateway.sessionSnapshot();
        if (!alive || generation !== requestGeneration.current) return;
        setSessionSnapshot(snapshot);
        const connection = snapshot.status === "ready" ? snapshot.connection : null;
        if (connection && missingCoreCapabilities(connection).length === 0) await start();
        else setPhase("disconnected");
      } catch (error) {
        if (!alive || generation !== requestGeneration.current) return;
        setNotice(gatewayError(error));
        setPhase("disconnected");
      }
    })();
    return () => { alive = false; stopSessionChanges?.(); };
  }, [collectionEpoch, gateway, setNotice, setPhase, setSessionSnapshot, start]);

  return { retrySessionStart };
}

function sameAuthoritativeSnapshot(event: CollectionSessionSnapshot, current: CollectionSessionSnapshot): boolean {
  if (event.status !== current.status) return false;
  if (event.status === "ready" && current.status === "ready") {
    return event.connection.collectionId === current.connection.collectionId;
  }
  if (event.status === "unavailable" && current.status === "unavailable") {
    return event.collectionId === current.collectionId;
  }
  return true;
}
