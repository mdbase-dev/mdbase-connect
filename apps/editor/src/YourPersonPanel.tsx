import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountProfile, CollectionDescription } from "@mdbase-dev/connect";
import type { CollectionGateway, CreateNoteInput } from "./model";
import { NewNoteComposer } from "./NewNoteComposer";
import { identityPatch, matchingPerson, newPersonProperties, personImplementations, personRecords } from "./person-records";

type Person = ReturnType<typeof personRecords>[number];

export function YourPersonPanel({ gateway, description, canCreate, canEdit }: {
  gateway: CollectionGateway;
  description: CollectionDescription;
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [identity, setIdentity] = useState<AccountProfile>();
  const [records, setRecords] = useState<Person[]>();
  const [linked, setLinked] = useState<Person>();
  const [path, setPath] = useState("");
  const [typeName, setTypeName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const lifecycle = useRef<AbortController | null>(null);
  const implementations = personImplementations(description).filter((candidate) => ["id", "name", "identities"].every((field) => candidate.fields[field] || candidate.fields[`/${field}`]));
  const implementation = implementations.find((candidate) => candidate.typeName === typeName) ?? implementations[0];
  const properties = useMemo(() => identity && implementation ? newPersonProperties(implementation, identity, identity.name) : {}, [identity, implementation]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setRecords(undefined); setIdentity(undefined); setLinked(undefined); setError("");
    void (async () => {
      try {
        if (!gateway.currentIdentity) throw new Error("This collection has no Connect account identity.");
        const [account, index] = await Promise.all([gateway.currentIdentity({ signal: controller.signal }), gateway.list({ signal: controller.signal })]);
        if (controller.signal.aborted) return;
        const people = personRecords(description, index.notes);
        const match = matchingPerson(people, account);
        setIdentity(account); setRecords(people); setLinked(match);
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load people.");
      }
    })();
    return () => controller.abort();
  }, [gateway, description, revision]);

  function assertCurrent() {
    const snapshot = gateway.sessionSnapshot();
    if (lifecycle.current?.signal.aborted || snapshot.status !== "ready" || snapshot.connection.collectionId !== description.collectionId) {
      throw new Error("The selected collection changed. Open its person settings again.");
    }
  }

  async function link() {
    if (!identity || !records || busy || !canEdit) return;
    setBusy(true); setError("");
    try {
      assertCurrent();
      // Requery before linking: never infer uniqueness from the old picker.
      const index = await gateway.list({ signal: lifecycle.current?.signal });
      const people = personRecords(description, index.notes);
      if (matchingPerson(people, identity)) throw new Error("Your account is already linked. Reload these settings.");
      const selected = people.find((record) => record.path === path);
      if (!selected || people.filter((record) => record.id === selected.id).length !== 1) throw new Error("Select a person with a unique ID.");
      assertCurrent();
      const record = await gateway.read(path);
      assertCurrent();
      await gateway.updateProperties(path, identityPatch(record.frontmatter, selected.implementation, identity), record.revision);
      if (!lifecycle.current?.signal.aborted) setRevision((value) => value + 1);
    } catch (reason) {
      if (!lifecycle.current?.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not link this person.");
    } finally { setBusy(false); }
  }

  async function create(input: CreateNoteInput) {
    assertCurrent();
    if (!identity || !implementation || !canCreate || input.type !== implementation.typeName) throw new Error("Select a Person-compatible type.");
    const index = await gateway.list({ signal: lifecycle.current?.signal });
    if (matchingPerson(personRecords(description, index.notes), identity)) throw new Error("Your account is already linked. Reload these settings.");
    assertCurrent();
    await gateway.create(input);
    if (!lifecycle.current?.signal.aborted) { setCreating(false); setRevision((value) => value + 1); }
  }

  return <section aria-label="Your person record">
    <div className="settings-intro"><h2>Your person record</h2><p>Represent yourself using an ordinary note in this collection. This does not change access or membership.</p></div>
    {error && <p role="alert">{error}</p>}
    {!records && !error && <p role="status">Loading your identity and person records…</p>}
    {error && <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button>}
    {linked && <p>Linked to <strong>{linked.name}</strong> · <code>{linked.path}</code>. Edit this note to change its collection display name or identity associations.</p>}
    {records && !linked && <>
      <p>Your account: <strong>{identity?.name}</strong>. The record's display name belongs to this collection and is not synchronised with your account.</p>
      {records.length > 0 && <div className="setting-row"><label>Existing person or contact<select aria-label="Existing person or contact" value={path} onChange={(event) => setPath(event.target.value)} disabled={busy}>
        <option value="">Choose a record…</option>{records.map((record) => <option key={record.path} value={record.path}>{record.name} · {record.path}</option>)}
      </select></label><button type="button" disabled={!path || busy || !canEdit} onClick={() => void link()}>Link this record to me</button></div>}
      {!canEdit && <p>Ask a collection editor to link your person record.</p>}
      <p>Only records whose type implements Person can be linked here. To use a Contact-only note, add the Person contract and field mappings to its type in Types first. Required IDs affect all records of that type; review those changes explicitly.</p>
      {implementations.length === 0 && <p>No type implements Person yet. Install the People and contacts pack from Types, or configure an existing type. No files or types will be created automatically.</p>}
      {implementations.length > 0 && canCreate && !creating && <div className="setting-row"><label>Person type<select aria-label="Person type" value={implementation?.typeName ?? ""} onChange={(event) => setTypeName(event.target.value)}>{implementations.map((item) => <option key={item.typeName} value={item.typeName}>{item.typeName}</option>)}</select></label><button type="button" onClick={() => setCreating(true)}>Create my person record</button></div>}
      {creating && implementation && identity && <NewNoteComposer key={implementation.typeName} types={description.types.filter((type) => type.name === implementation.typeName)} defaultType={implementation.typeName} initialTitle={identity.name} initialProperties={properties} recordPaths={records.map((record) => record.path)} onCreate={create} onCancel={() => setCreating(false)} />}
    </>}
  </section>;
}
