import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { t } from "@lingui/core/macro";
import type { connectDirect } from "@mdbase-dev/sdk-self-hosted/direct";
import { CodeEditor } from "../src/CodeEditor";

export type DirectClient = Awaited<ReturnType<typeof connectDirect>>;
export interface UnsavedText { path: string; body: string }
type DraftReader = RefObject<(() => UnsavedText | undefined) | undefined>;
type Lease = Awaited<ReturnType<DirectClient["records"]["open"]>>;
type Inventory = ReturnType<DirectClient["recordSet"]>;
type Draft = ReturnType<Lease["session"]["getSnapshot"]>;
function unconfirmed(draft: Draft) {
  return draft.dirty || !!draft.recovery || draft.state === "saving" || draft.state === "saved_on_device";
}

export function RecordWorkspace({ client, readDraft, discard }: { client: DirectClient; readDraft: DraftReader; discard(): void }) {
  const [inventory, setInventory] = useState<Inventory>();
  const [selected, select] = useState<string>();
  useEffect(() => {
    const records = client.recordSet();
    setInventory(records);
    return () => records.close();
  }, [client]);
  if (selected) return <OpenRecord client={client} id={selected} readDraft={readDraft} back={() => {
    if (!readDraft.current?.()) select(undefined);
    else if (window.confirm(t`Discard unsaved changes?`)) discard();
  }} />;
  return inventory && <RecordList inventory={inventory} select={select} />;
}

function RecordList({ inventory, select }: { inventory: Inventory; select(id: string): void }) {
  const listing = useSyncExternalStore(inventory.subscribe, inventory.getSnapshot);
  return <section><h2>{t`Notes`}</h2>{listing.state === "failed" ? <p role="alert">{t`Could not load the collection.`}{" "}
    <button onClick={() => void inventory.reload().catch(() => {})}>{t`Retry`}</button></p> :
    <>{listing.state !== "current" && <p role="status">{t`Reading notes…`}</p>}
      {listing.state === "current" && !listing.records.length && <p>{t`No notes in this collection.`}</p>}
      <ul>{listing.records.map(record => <li key={record.id}><button onClick={() => select(record.id)}>{record.path}</button></li>)}</ul></>}
  </section>;
}

function OpenRecord({ client, id, back, readDraft }: { client: DirectClient; id: string; back(): void; readDraft: DraftReader }) {
  const [lease, setLease] = useState<Lease>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let current: Lease | undefined;
    void client.records.open(id, { autosave: false, requireLive: true, signal: controller.signal }).then(opened => {
      if (controller.signal.aborted) opened.release();
      else { current = opened; setLease(opened); }
    }, () => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); current?.release(); };
  }, [client, id]);
  if (!lease) return <><button onClick={back}>{t`All notes`}</button><p role="status">{failed ? t`Could not read this note.` : t`Opening note…`}</p></>;
  return <Note client={client} lease={lease} back={back} readDraft={readDraft} />;
}

function Note({ client, lease: { session }, back, readDraft }: { client: DirectClient; lease: Lease; back(): void; readDraft: DraftReader }) {
  const draft = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [attempt, setAttempt] = useState<"idle" | "saving" | "failed">("idle");
  const saving = attempt === "saving" || draft.state === "saving";
  const readOnly = saving || draft.state === "deleted" || draft.state === "recovery" || draft.state === "conflict" || draft.state === "saved_on_device";
  const warnOnLeave = unconfirmed(draft);
  useLayoutEffect(() => {
    readDraft.current = () => {
      const snapshot = session.getSnapshot();
      if (unconfirmed(snapshot))
        return { path: snapshot.record.path, body: snapshot.body };
    };
    return () => { readDraft.current = undefined; };
  }, [readDraft, session]);
  useEffect(() => {
    if (!warnOnLeave) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [warnOnLeave]);
  return <section><button disabled={saving} onClick={back}>{t`All notes`}</button>
    <h2>{draft.record.path}</h2><CodeEditor label={t`Note body`} language="markdown" variant="source" value={draft.body}
      onChange={body => {
        if (readOnly || client.link !== "open" || body === session.getSnapshot().body) return;
        setAttempt("idle"); session.setBody(body);
      }} readOnly={readOnly} autoFocus />
    <div className="session"><button disabled={!draft.dirty || readOnly} onClick={async () => {
      if (client.link !== "open" || !session.getSnapshot().dirty || readOnly) return;
      setAttempt("saving");
      try { setAttempt((await session.flush()).ok ? "idle" : "failed"); } catch { setAttempt("failed"); }
    }}>{t`Save note`}</button><span role="status">{saving ? t`Saving…` : draft.state === "conflict" ? t`The note changed elsewhere. Copy your text before reopening it.` :
      draft.state === "deleted" ? t`This note was deleted.` : attempt === "failed" || draft.problem || draft.state === "recovery" ? t`Could not confirm the save.` :
      draft.state === "saved" ? t`Saved` : draft.state === "saved_on_device" ? t`Awaiting confirmation` : t`Unsaved changes`}</span></div>
  </section>;
}
