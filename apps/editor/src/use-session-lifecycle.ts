import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import type { AppPhase } from "./app-state-types";
import { gatewayError, missingCoreCapabilities } from "./gateway";
import type { CollectionGateway, CollectionSessionSnapshot } from "./model";

export function useSessionLifecycle({ gateway, start, setSessionSnapshot, setNotice, setPhase }: {
  gateway: CollectionGateway;
  start: () => Promise<void>;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
  setPhase: Dispatch<SetStateAction<AppPhase>>;
}) {
  const retrySessionStart = useCallback(async () => {
    try {
      const snapshot = await gateway.startSession();
      setSessionSnapshot(snapshot);
      if (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length === 0) {
        await start();
      } else {
        setNotice(snapshot.status === "start_failed" ? snapshot.problem.message : undefined);
        setPhase("disconnected");
      }
    } catch (error) {
      setNotice(gatewayError(error));
      setPhase("disconnected");
    }
  }, [gateway, setNotice, setPhase, setSessionSnapshot, start]);

  useEffect(() => {
    let alive = true;
    let stopSessionChanges: (() => void) | undefined;
    void (async () => {
      try {
        const initial = await gateway.startSession();
        if (!alive) return;
        setSessionSnapshot(initial);
        if (initial.status === "start_failed") setNotice(initial.problem.message);
        if (initial.status === "destroyed") setNotice("This editor session has been closed.");
        stopSessionChanges = gateway.onSessionChange((snapshot) => {
          setSessionSnapshot(snapshot);
          if (snapshot.status !== "ready") {
            setPhase((current) => current === "starting" ? current : "disconnected");
          }
        });
        const snapshot = gateway.sessionSnapshot();
        setSessionSnapshot(snapshot);
        const connection = snapshot.status === "ready" ? snapshot.connection : null;
        if (connection && missingCoreCapabilities(connection).length === 0) await start();
        else setPhase("disconnected");
      } catch (error) {
        if (!alive) return;
        setNotice(gatewayError(error));
        setPhase("disconnected");
      }
    })();
    return () => {
      alive = false;
      stopSessionChanges?.();
    };
  }, [gateway, setNotice, setPhase, setSessionSnapshot, start]);

  return { retrySessionStart };
}
