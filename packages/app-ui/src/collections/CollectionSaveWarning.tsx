import type { Mdbase } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { createContext, useContext, useSyncExternalStore, type JSX } from "react";

/** The gate supplies the entry to status controls inside the open workspace. */
export const CollectionMdbaseContext = createContext<Mdbase | null>(null);
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

/** Quiet storage-risk copy beside an app's save status. Never shown without
 * the SDK's warning: persistence/installation policy stays SDK-owned. */
export function useCollectionSaveWarning(supplied?: Mdbase) {
  const inherited = useContext(CollectionMdbaseContext);
  const mdbase = supplied ?? inherited;
  const snapshot = useSyncExternalStore(mdbase?.subscribe ?? emptySubscribe, mdbase?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const warning = snapshot?.saveWarning;
  return warning ? describeError(warning) : null;
}

export function CollectionSaveWarning({ mdbase }: { readonly mdbase?: Mdbase }): JSX.Element | null {
  const copy = useCollectionSaveWarning(mdbase);
  if (!copy) return null;
  return <span className="mdbase-collections-save-warning" role="status" title={copy.message}>{copy.message}</span>;
}
