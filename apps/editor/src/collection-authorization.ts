import type { MdbaseFirstContactChallenge } from "@mdbase-dev/connect";
import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { missingCoreOperations } from "./gateway";
import type {
  CollectionAuthorizationTarget,
  CollectionGateway,
  CollectionSessionSnapshot
} from "./model";

interface FirstContactState {
  challenge: MdbaseFirstContactChallenge;
  cancel(): void;
}

export function useCollectionAuthorization(input: {
  gateway: CollectionGateway;
  phase: "starting" | "disconnected" | "loading" | "ready";
  start(): Promise<void>;
  setSessionSnapshot: Dispatch<SetStateAction<CollectionSessionSnapshot>>;
}) {
  const [firstContact, setFirstContact] = useState<FirstContactState>();

  async function authorizeCollection(target: CollectionAuthorizationTarget) {
    const controller = new AbortController();
    const previous = input.gateway.sessionSnapshot();
    setFirstContact(undefined);
    try {
      await input.gateway.authorize(target, {
        signal: controller.signal,
        onFirstContact: (challenge) => setFirstContact({
          challenge,
          cancel: () => controller.abort()
        })
      });
      const next = input.gateway.sessionSnapshot();
      input.setSessionSnapshot(next);
      if (
        next.status === "ready"
        && missingCoreOperations(next.connection).length === 0
        && (
          input.phase !== "ready"
          || previous.status !== "ready"
          || previous.connection.collectionId !== next.connection.collectionId
        )
      ) {
        await input.start();
      }
    } finally {
      setFirstContact(undefined);
    }
  }

  return { authorizeCollection, firstContact };
}
