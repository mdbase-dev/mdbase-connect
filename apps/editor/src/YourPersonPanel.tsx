import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountProfile, CollectionDescription, JsonObject } from "@mdbase-dev/connect";
import type { CollectionGateway, CreateNoteInput } from "./model";
import { NewNoteComposer } from "./NewNoteComposer";
import { contactPersonPatch, contactRecords, identityPatch, matchingPerson, newPersonProperties, personImplementations, personRecords } from "./person-records";

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
  const [contacts, setContacts] = useState<ReturnType<typeof contactRecords>>([]);
  const [conversion, setConversion] = useState<{ path: string; revision: string; patch: JsonObject; personId: string; typeName: string }>();
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
    setRecords(undefined); setIdentity(undefined); setLinked(undefined); setConversion(undefined); setError("");
    void (async () => {
      try {
        if (!gateway.currentIdentity) throw new Error("This collection has no Connect account identity.");
        const [account, index] = await Promise.all([gateway.currentIdentity({ signal: controller.signal }), gateway.list({ signal: controller.signal })]);
        if (controller.signal.aborted) return;
        const people = personRecords(description, index.notes);
        const match = matchingPerson(people, account);
        setIdentity(account); setRecords(people); setContacts(contactRecords(description, index.notes)); setLinked(match);
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
      const contact = contactRecords(description, index.notes).find((record) => record.path === path);
      if (contact) {
        if (!implementation) throw new Error("Install or configure a type implementing both Person and Contact first.");
        assertCurrent();
        const record = await gateway.read(path);
        assertCurrent();
        const prepared = contactPersonPatch(description, record.frontmatter, contact.source, implementation, identity);
        if (people.some((person) => person.id === prepared.personId)) throw new Error("The contact's proposed person ID already belongs to another record.");
        setConversion({ ...prepared, path, revision: record.revision, typeName: implementation.typeName });
        return;
      }
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

  async function convertContact() {
    if (!conversion || !identity || busy || !canEdit) return;
    setBusy(true); setError("");
    try {
      assertCurrent();
      const index = await gateway.list({ signal: lifecycle.current?.signal });
      const people = personRecords(description, index.notes);
      if (matchingPerson(people, identity) || people.some((person) => person.id === conversion.personId)) throw new Error("A person record now matches this account or ID. Reload and review the association.");
      assertCurrent();
      await gateway.updateProperties(conversion.path, conversion.patch, conversion.revision);
      if (!lifecycle.current?.signal.aborted) setRevision((value) => value + 1);
    } catch (reason) {
      if (!lifecycle.current?.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not convert this contact. Its type may need additional fields or compatible mappings.");
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
      {(records.length > 0 || contacts.length > 0) && <div className="setting-row"><label>Existing person or contact<select aria-label="Existing person or contact" value={path} onChange={(event) => { setPath(event.target.value); setConversion(undefined); }} disabled={busy}>
        <option value="">Choose a record…</option>{records.map((record) => <option key={record.path} value={record.path}>{record.name} · {record.path}</option>)}
        {contacts.map((contact) => <option key={contact.path} value={contact.path}>{contact.name} · {contact.path} (Contact-only)</option>)}
      </select></label><button type="button" disabled={!path || busy || !canEdit} onClick={() => void link()}>{contacts.some((contact) => contact.path === path) ? "Review contact conversion" : "Link this record to me"}</button></div>}
      {conversion && <div role="region" aria-label="Review contact conversion"><p>This changes only <code>{conversion.path}</code> to the <strong>{conversion.typeName}</strong> type, which implements both Person and Contact. Its contact information and Markdown body are retained. No other contacts or type definitions are changed.</p><details><summary>Review fields to write</summary><pre>{JSON.stringify(conversion.patch, null, 2)}</pre></details><button type="button" disabled={busy || !canEdit} onClick={() => void convertContact()}>Convert and link this contact</button><button type="button" disabled={busy} onClick={() => setConversion(undefined)}>Cancel conversion</button></div>}
      {!canEdit && <p>Ask a collection editor to link your person record.</p>}
      <p>Person-compatible records are linked directly. A Contact-only note can be explicitly converted to a type implementing both contracts, without migrating the whole address book. Alternatively, configure Person mappings on its existing type in Types; required IDs affect every record of that type.</p>
      {implementations.length === 0 && <p>No type implements Person yet. Install the People and contacts pack from Types, or configure an existing type. No files or types will be created automatically.</p>}
      {implementations.length > 0 && (canCreate || canEdit) && !creating && <div className="setting-row"><label>Person type<select aria-label="Person type" value={implementation?.typeName ?? ""} onChange={(event) => { setTypeName(event.target.value); setConversion(undefined); }}>{implementations.map((item) => <option key={item.typeName} value={item.typeName}>{item.typeName}</option>)}</select></label>{canCreate && <button type="button" onClick={() => setCreating(true)}>Create my person record</button>}</div>}
      {creating && implementation && identity && <NewNoteComposer key={implementation.typeName} types={description.types.filter((type) => type.name === implementation.typeName)} defaultType={implementation.typeName} initialTitle={identity.name} initialProperties={properties} recordPaths={records.map((record) => record.path)} onCreate={create} onCancel={() => setCreating(false)} />}
    </>}
  </section>;
}
