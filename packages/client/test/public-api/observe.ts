import {
  MdbaseQueryObserver,
  type MdbaseConnection, type ObserveOptions, type ObserveSnapshot,
  type ObserveDelta, type ObserveOverlay, type ConnectOutcome, type JsonObject
} from "@mdbase-dev/connect";

import { MdbaseCollectionClient } from "@mdbase-dev/connect/advanced";

interface Fields extends JsonObject { title: string }
declare const connection: MdbaseConnection;
declare const collection: MdbaseCollectionClient<Fields>;
const options: ObserveOptions = { mode: "manual", invalidation: "paths", coalesceMs: 50, maxPendingPaths: 1000 };
const live: MdbaseQueryObserver<Fields> = collection.observe({ types: ["note"], frontmatterMode: "both" }, options);
const initial: Promise<ConnectOutcome<void>> = live.ready;
const snapshot: ObserveSnapshot<Fields> = live.getSnapshot();
const title: string | undefined = snapshot.records[0]?.effectiveFrontmatter?.title;
const stop: () => void = live.subscribe((state: ObserveSnapshot<Fields>, delta: ObserveDelta<Fields>) => {
  const paths: readonly string[] = delta.removed;
  // @ts-expect-error Published delta membership is immutable.
  delta.removed.push("new.md");
  void [state, paths];
});
const effects: () => void = live.subscribeChanges(change => { void change.kind; });
const overlay: ObserveOverlay = live.optimistic([], ["a.md"]);
overlay.commit(); overlay.rollback();
const refresh: Promise<ConnectOutcome<void>> = live.refresh();
const hydration: Promise<ConnectOutcome<void>> = live.hydrate();
connection.observe({}, { signal: new AbortController().signal }).close();
// @ts-expect-error Snapshot membership cannot be mutated.
snapshot.records.push({ path: "a.md", types: [], file: {} });
// @ts-expect-error Snapshot status cannot be assigned.
snapshot.state = "ready";
// @ts-expect-error Partial metadata output is not a record observation.
collection.observe({ output: "metadata" });
void [initial, title, stop, effects, refresh, hydration];
