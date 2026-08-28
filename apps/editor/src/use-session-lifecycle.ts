import { useCallback, useEffect, useRef } from "react";
import { gatewayError } from "./gateway";
import type { CollectionGateway, CollectionSessionSnapshot } from "./model";

export function useSessionLifecycle({ gateway, acceptSnapshot, setNotice }: {
  gateway: CollectionGateway;
  acceptSnapshot: (snapshot: CollectionSessionSnapshot) => Promise<void>;
  setNotice: (message?: string, tone?: "info" | "success" | "error") => void;
}) {
  const requestGeneration = useRef(0);
  const retrySessionStart = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const snapshot = await gateway.startSession();
      if (generation !== requestGeneration.current) return;
      const current = gateway.sessionSnapshot();
      await acceptSnapshot(sameAuthoritativeSnapshot(snapshot, current) ? snapshot : current);
    } catch (error) {
      if (generation === requestGeneration.current) setNotice(gatewayError(error));
    }
  }, [acceptSnapshot, gateway, setNotice]);

  useEffect(() => {
    let alive = true;
    let stopSessionChanges: (() => void) | undefined;
    const generation = ++requestGeneration.current;
    void (async () => {
      try {
        const initial = await gateway.startSession();
        if (!alive || generation !== requestGeneration.current) return;
        if (initial.status === "start_failed") setNotice(initial.problem.message);
        if (initial.status === "destroyed") setNotice("This editor session has been closed.");
        stopSessionChanges = gateway.onSessionChange((snapshot) => {
          if (!alive || !sameAuthoritativeSnapshot(snapshot, gateway.sessionSnapshot())) return;
          void acceptSnapshot(snapshot).catch((error) => { if (alive) setNotice(gatewayError(error)); });
        });
        const snapshot = gateway.sessionSnapshot();
        if (!alive || generation !== requestGeneration.current || !sameAuthoritativeSnapshot(initial, snapshot)) return;
        await acceptSnapshot(snapshot);
      } catch (error) {
        if (alive && generation === requestGeneration.current) setNotice(gatewayError(error));
      }
    })();
    return () => { alive = false; stopSessionChanges?.(); };
  }, [acceptSnapshot, gateway, setNotice]);

  return { retrySessionStart };
}

export function sameAuthoritativeSnapshot(event: CollectionSessionSnapshot, current: CollectionSessionSnapshot): boolean {
  if (event.status !== current.status) return false;
  if (event.status === "ready" && current.status === "ready") {
    return event.connection.collectionId === current.connection.collectionId;
  }
  if (event.status === "unavailable" && current.status === "unavailable") {
    return event.collectionId === current.collectionId;
  }
  return true;
}
