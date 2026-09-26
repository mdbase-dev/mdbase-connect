import type { MdbaseRecordSessionAdapter } from "../../api-candidate/advanced.js";
import {
  MdbaseRecordSession,
  type JsonObject,
  type MdbaseConnection,
  type MdbaseRecordSessionSnapshot,
  type RecordDocument
} from "../../api-candidate/index.js";

interface NoteFrontmatter extends JsonObject {
  title?: string;
}

/** A browser editor keeps one record open across views and stays live from a watch. */
export async function recordEditingSpike(connection: MdbaseConnection<NoteFrontmatter>): Promise<void> {
  const watch = await connection.watch({}, { timeoutMs: 10_000 });
  const stopFollowing = watch.ok ? connection.records.follow(watch.value) : () => undefined;

  const opened = await connection.records.open("Notes/one.md", { autosave: { idleMs: 750 }, timeoutMs: 8_000 });
  if (!opened.ok) return;
  const { session, release } = opened.value;
  const render = (snapshot: MdbaseRecordSessionSnapshot<RecordDocument<NoteFrontmatter>>) =>
    `${snapshot.state}:${snapshot.record.frontmatter.title ?? ""}`;
  const unsubscribe = session.subscribe(() => render(session.getSnapshot()));

  session.setBody("# One\n\nEdited");
  session.patchFrontmatter({ title: "One" });
  const flushed = await session.flush({ timeoutMs: 8_000 });
  if (!flushed.ok && flushed.problem.code === "concurrent_modification") {
    session.resolve({ keep: "mine" });
  }
  unsubscribe();
  release();
  stopFollowing();
}

/** Applications with their own repository supply an adapter from `/advanced`. */
export function customTransportSpike<R>(record: R, adapter: MdbaseRecordSessionAdapter<R>): MdbaseRecordSession<R> {
  return new MdbaseRecordSession(record, adapter, { autosave: false });
}
