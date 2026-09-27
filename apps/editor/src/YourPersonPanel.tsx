import { useEffect, useMemo, useRef, useState } from "react";
import type { CollectionDescription, JsonObject, PeopleDirectory, PersonResolution, TypePackAssessment, TypePackProvision } from "@mdbase-dev/connect";
import type { CollectionGateway, CreateNoteInput } from "./model";
import { NewNoteComposer } from "./NewNoteComposer";
import { readFieldReference } from "./field-reference";
import { claimedByAnotherAccount, contactCandidates, contactPersonPatch, identityPatch, newPersonProperties, personField, personImplementations, writablePersonImplementation, type ContactCandidate } from "./person-records";

import { loadPersonSetup, requireAdditivePersonSetup } from "./person-setup";

export function YourPersonPanel({ gateway, description, canCreate, canEdit, canInstall = false, onRefreshDescription }: {
  gateway: CollectionGateway;
  description: CollectionDescription;
  canCreate: boolean;
  canEdit: boolean;
  canInstall?: boolean;
  onRefreshDescription?: () => Promise<CollectionDescription | undefined>;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash === "#your-person") panel.current?.focus();
  }, []);
  const [directory, setDirectory] = useState<PeopleDirectory>();
  const [contacts, setContacts] = useState<ContactCandidate[]>([]);
  const [confirmClaimed, setConfirmClaimed] = useState(false);
  const [conversion, setConversion] = useState<{ path: string; revision: string; patch: JsonObject; personId: string; typeName: string }>();
  const [path, setPath] = useState("");
  const [typeName, setTypeName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [setup, setSetup] = useState<{ provision: TypePackProvision; assessment: TypePackAssessment; controller: AbortController }>();
  const setupPanel = useRef<HTMLElement>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const wasReviewing = useRef(false);
  useEffect(() => {
    if (setup) setupPanel.current?.focus();
    else if (wasReviewing.current) setupButton.current?.focus();
    wasReviewing.current = !!setup;
  }, [setup]);
  const lifecycle = useRef<AbortController | null>(null);
  const implementations = personImplementations(description).filter((candidate) => ["id", "name", "identities"].every((field) => candidate.fields[field] || candidate.fields[`/${field}`]));
  const implementation = implementations.find((candidate) => candidate.typeName === typeName) ?? implementations[0];
  const identity = directory?.account;
  const records = directory?.people;
  const linked = directory?.me.status === "linked" ? directory.me.person : undefined;
  const existingIds = useMemo(() => directory ? [...directory.people.map((person) => person.id), ...directory.duplicateIds] : [], [directory]);
  const properties = useMemo(() => identity && implementation ? newPersonProperties(implementation, identity, identity.name, existingIds) : {}, [identity, implementation, existingIds]);
  const selectedPerson = records?.find((record) => record.path === path);
  const selectedIsClaimed = Boolean(identity && selectedPerson && claimedByAnotherAccount(selectedPerson, identity));

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setDirectory(undefined); setContacts([]); setConversion(undefined); setSetup(undefined); setError(""); setConfirmClaimed(false);
    void (async () => {
      try {
        if (!gateway.peopleDirectory) throw new Error("This collection has no Connect account identity.");
        const next = await gateway.peopleDirectory({ signal: controller.signal });
        const candidates = next.me.status === "unlinked" ? await contactCandidates(gateway, description, next, controller.signal) : [];
        if (controller.signal.aborted) return;
        setDirectory(next); setContacts(candidates);
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

  async function reviewSetup() {
    const controller = lifecycle.current;
    if (busy || !canInstall || !onRefreshDescription || !controller) return;
    setBusy(true); setError("");
    try {
      assertCurrent();
      const provision = await loadPersonSetup(controller.signal);
      if (controller.signal.aborted) return;
      assertCurrent();
      const assessment = await gateway.assessTypePack(provision);
      if (controller.signal.aborted) return;
      assertCurrent();
      requireAdditivePersonSetup(assessment);
      setSetup({ provision, assessment, controller });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not review person setup.");
    } finally { setBusy(false); }
  }

  async function approveSetup() {
    if (!setup || busy || !canInstall || !onRefreshDescription) return;
    setBusy(true); setError("");
    try {
      assertCurrent();
      if (setup.controller.signal.aborted) throw new Error("The collection changed. Review person setup again.");
      // The gateway passes the exact reviewed assessment digest to the atomic apply.
      await gateway.applyTypePack(setup.provision, setup.assessment);
      // A definition watch may already have refreshed the description after our
      // write. Check the live collection lifetime, not the pre-write review.
      if (lifecycle.current?.signal.aborted) return;
      assertCurrent();
      const next = await onRefreshDescription();
      if (!next || next.collectionId !== description.collectionId) return;
      if (!personImplementations(next).some((candidate) => ["id", "name", "identities"].every((field) => candidate.fields[field] || candidate.fields[`/${field}`]))) {
        throw new Error("Definitions were added, but their Person mappings need review in Types.");
      }
      setSetup(undefined); setCreating(canCreate && !path);
    } catch (reason) {
      setSetup(undefined);
      if (!lifecycle.current?.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not add person definitions. Review setup again.");
    } finally { setBusy(false); }
  }

  /** Requery before every write: never infer uniqueness from the loaded picker. */
  async function freshUnlinkedDirectory() {
    const fresh = await gateway.peopleDirectory!({ signal: lifecycle.current?.signal });
    if (fresh.me.status !== "unlinked") throw new Error("A person record now matches your account. Reload these settings.");
    return fresh;
  }

  async function link() {
    if (!identity || !records || busy || !canEdit) return;
    setBusy(true); setError("");
    try {
      assertCurrent();
      const fresh = await freshUnlinkedDirectory();
      const contact = contacts.find((record) => record.path === path);
      if (contact) {
        if (!implementation) throw new Error("Set up person records below before reviewing this contact.");
        assertCurrent();
        const record = await gateway.read(path);
        assertCurrent();
        const ids = [...fresh.people.map((person) => person.id), ...fresh.duplicateIds];
        const prepared = contactPersonPatch(description, record.frontmatter, contact.source, implementation, identity, ids);
        if (ids.includes(prepared.personId)) throw new Error("The contact's proposed person ID already belongs to another record.");
        setConversion({ ...prepared, path, revision: record.revision, typeName: implementation.typeName });
        return;
      }
      const selected = fresh.people.find((record) => record.path === path);
      if (!selected || fresh.duplicateIds.includes(selected.id)) throw new Error("Select a person with a unique ID.");
      if (claimedByAnotherAccount(selected, identity) && !confirmClaimed) {
        setConfirmClaimed(true);
        return;
      }
      const target = writablePersonImplementation(description, selected);
      assertCurrent();
      const record = await gateway.read(path);
      assertCurrent();
      await gateway.updateProperties(path, identityPatch(record.frontmatter, target, identity), record.revision);
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
      const fresh = await freshUnlinkedDirectory();
      if (fresh.people.some((person) => person.id === conversion.personId)) throw new Error("Another person record now uses this ID. Reload and review the association.");
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
    const fresh = await freshUnlinkedDirectory();
    if (fresh.people.some((person) => person.id === readFieldReference(input.properties, personField(implementation, "id")))) {
      throw new Error("Another person record now uses this ID. Choose a different ID.");
    }
    assertCurrent();
    await gateway.create(input);
    if (!lifecycle.current?.signal.aborted) { setCreating(false); setRevision((value) => value + 1); }
  }

  return <section ref={panel} id="your-person" tabIndex={-1} aria-label="Your person record">
    <div className="settings-intro"><h2>Your person record</h2><p>Represent yourself using an ordinary note in this collection. This does not change access or membership.</p></div>
    {error && <p role="alert">{error}</p>}
    {!records && !error && <p role="status">Loading your identity and person records…</p>}
    {error && <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button>}
    {linked && <p>Linked to <strong>{linked.name}</strong> · <code>{linked.path}</code>. Edit this note to change its collection display name or identity associations.</p>}
    {directory && <ResolutionProblem resolution={directory.me} />}
    {directory && directory.invalid.length > 0 && <details><summary>{directory.invalid.length === 1 ? "1 person record needs attention" : `${directory.invalid.length} person records need attention`}</summary><ul>{directory.invalid.map((record) => <li key={record.path}><code>{record.path}</code>: {record.reason}</li>)}</ul></details>}
    {records && directory?.me.status === "unlinked" && <>
      <p>Your account: <strong>{identity?.name}</strong>. The record's display name belongs to this collection and is not synchronised with your account.</p>
      {(records.length > 0 || contacts.length > 0) && <div className="setting-row"><label>Existing person or contact<select aria-label="Existing person or contact" value={path} onChange={(event) => { setPath(event.target.value); setConversion(undefined); setConfirmClaimed(false); }} disabled={busy}>
        <option value="">Choose a record…</option>{records.map((record) => <option key={record.path} value={record.path}>{record.name} · {record.path}</option>)}
        {contacts.map((contact) => <option key={contact.path} value={contact.path}>{contact.name} · {contact.path} (Contact-only)</option>)}
      </select></label><button type="button" disabled={!path || busy || !canEdit} onClick={() => void link()}>{contacts.some((contact) => contact.path === path) ? "Review contact conversion" : confirmClaimed ? "Link anyway" : "Link this record to me"}</button></div>}
      {selectedIsClaimed && <p role={confirmClaimed ? "alert" : undefined}>This record is already linked to another account. Linking it to yours means you will both see its assignments as your own. Only continue if this record really represents you.</p>}
      {conversion && <div role="region" aria-label="Review contact conversion"><p>This changes only <code>{conversion.path}</code> to the <strong>{conversion.typeName}</strong> type, which implements both Person and Contact. Its contact information and Markdown body are retained. No other contacts or type definitions are changed.</p><details><summary>Review fields to write</summary><pre>{JSON.stringify(conversion.patch, null, 2)}</pre></details><button type="button" disabled={busy || !canEdit} onClick={() => void convertContact()}>Convert and link this contact</button><button type="button" disabled={busy} onClick={() => setConversion(undefined)}>Cancel conversion</button></div>}
      {!canEdit && <p>Ask a collection editor to link your person record.</p>}
      <details><summary>About existing contacts</summary><p>You can link an existing person directly, or review converting a single contact without changing the rest of your address book. Advanced Person mappings are available in Types; required fields there affect every record of that type.</p></details>
      {implementations.length === 0 && <>
        <p>This collection needs person definitions before you can create or link a person record. Nothing will be added without your approval.</p>
        {!setup && <button ref={setupButton} type="button" disabled={busy || !canInstall || !onRefreshDescription} onClick={() => void reviewSetup()}>{busy ? "Checking person setup…" : "Set up person records"}</button>}
        {!canInstall && <p>Adding definitions requires permission to manage this collection's types.</p>}
        {setup && <section ref={setupPanel} tabIndex={-1} aria-label="Review person setup">
          <h3>Allow person records in this collection?</h3>
          <p>Add one Person type, with optional contact details, and its supporting definitions. Existing notes, customized definitions, and access permissions will not be changed.</p>
          <details><summary>Review definition files</summary><ul>{setup.assessment.resources.map((resource) => <li key={resource.target}>{resource.action}: <code>{resource.target}</code></li>)}<li>{setup.assessment.lock.action}: <code>{setup.assessment.lock.target}</code> (setup receipt)</li></ul></details>
          <button type="button" disabled={busy || !canInstall} onClick={() => void approveSetup()}>{busy ? "Adding definitions…" : "Add definitions and continue"}</button>
          <button type="button" disabled={busy} onClick={() => setSetup(undefined)}>Not now</button>
        </section>}
      </>}
      {implementations.length > 0 && (canCreate || canEdit) && !creating && <div className="setting-row">{implementations.length > 1 && <label>Person type<select aria-label="Person type" value={implementation?.typeName ?? ""} onChange={(event) => { setTypeName(event.target.value); setConversion(undefined); }}>{implementations.map((item) => <option key={item.typeName} value={item.typeName}>{item.typeName}</option>)}</select></label>}{canCreate && <button type="button" onClick={() => setCreating(true)}>Create my person record</button>}</div>}
      {creating && implementation && identity && <NewNoteComposer key={implementation.typeName} types={description.types.filter((type) => type.name === implementation.typeName)} defaultType={implementation.typeName} initialTitle={identity.name} initialProperties={properties} recordPaths={records.map((record) => record.path)} onCreate={create} onCancel={() => setCreating(false)} />}
    </>}
  </section>;
}

function ResolutionProblem({ resolution }: { resolution: PersonResolution }) {
  if (resolution.status === "ambiguous") return <div role="alert"><p>Several person records match your account or share its person ID. Edit them so exactly one record represents you:</p><ul>{resolution.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>;
  if (resolution.status === "invalid") return <div role="alert"><p>A person record linked to your account has invalid fields. Fix it before relying on it:</p><ul>{resolution.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>;
  return null;
}
