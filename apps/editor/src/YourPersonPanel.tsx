import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MdbaseConnectError, type CollectionDescription, type JsonObject, type PeopleDirectory, type PersonResolution, type TypePackAssessment, type TypePackProvision } from "@mdbase-dev/connect";
import type { CollectionGateway, CreateNoteInput } from "./model";
import { NewNoteComposer } from "./NewNoteComposer";
import { claimedByAnotherAccount, contactCandidates, contactPersonPatch, identityPatch, newPersonProperties, personImplementations, writablePersonImplementation, type ContactCandidate } from "./person-records";

import { loadPersonSetup, outdatedPersonStarter, requireGuidedPersonSetup } from "./person-setup";
import { Select } from "@mdbase-dev/ui/select";
import { CaretRightIcon as ChevronRight } from "./icons";

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
  const [conversion, setConversion] = useState<{ path: string; revision: string; patch: JsonObject; typeName: string }>();
  const [path, setPath] = useState("");
  const [typeName, setTypeName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The grant predates People consent or the optional identity permission was declined.
  const [identityDenied, setIdentityDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const [setup, setSetup] = useState<{ provision: TypePackProvision; assessment: TypePackAssessment; upgrade?: ReturnType<typeof requireGuidedPersonSetup>["upgrade"]; controller: AbortController }>();
  const setupPanel = useRef<HTMLElement>(null);
  const setupButton = useRef<HTMLButtonElement>(null);
  const wasReviewing = useRef(false);
  // Layout effect: focus moves in the same commit that shows or hides the review.
  useLayoutEffect(() => {
    if (setup) setupPanel.current?.focus();
    else if (wasReviewing.current) setupButton.current?.focus();
    wasReviewing.current = !!setup;
  }, [setup]);
  const lifecycle = useRef<AbortController | null>(null);
  const implementations = personImplementations(description).filter((candidate) => ["name", "identities"].every((field) => candidate.fields[field] || candidate.fields[`/${field}`]));
  const implementation = implementations.find((candidate) => candidate.typeName === typeName) ?? implementations[0];
  const outdatedStarter = canInstall ? outdatedPersonStarter(implementations) : undefined;
  const identity = directory?.account;
  const records = directory?.people;
  const linked = directory?.me.status === "linked" ? directory.me.person : undefined;
  const properties = useMemo(() => identity && implementation ? newPersonProperties(implementation, identity, identity.name) : {}, [identity, implementation]);
  const selectedPerson = records?.find((record) => record.path === path);
  const selectedIsClaimed = Boolean(identity && selectedPerson && claimedByAnotherAccount(selectedPerson, identity));

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setDirectory(undefined); setContacts([]); setConversion(undefined); setSetup(undefined); setError(""); setIdentityDenied(false); setConfirmClaimed(false);
    void (async () => {
      try {
        if (!gateway.peopleDirectory) throw new Error("This collection has no Connect account identity.");
        const next = await gateway.peopleDirectory({ signal: controller.signal });
        const candidates = next.me.status === "unlinked" ? await contactCandidates(gateway, description, next, controller.signal) : [];
        if (controller.signal.aborted) return;
        setDirectory(next); setContacts(candidates);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof MdbaseConnectError && reason.code === "access_denied") setIdentityDenied(true);
        else setError(reason instanceof Error ? reason.message : "Could not load people.");
      }
    })();
    return () => controller.abort();
  }, [gateway, description, revision]);

  async function allowIdentity() {
    setBusy(true);
    try {
      await gateway.authorize("selected", { presentation: "popup" });
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The Editor was not approved.");
    } finally {
      setBusy(false);
    }
  }

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
      const { upgrade } = requireGuidedPersonSetup(provision, assessment);
      setSetup({ provision, assessment, upgrade, controller });
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
      if (!personImplementations(next).some((candidate) => ["name", "identities"].every((field) => candidate.fields[field] || candidate.fields[`/${field}`]))) {
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
        if (fresh.people.some((person) => person.path === path)) throw new Error("This record is already a person record. Reload these settings.");
        const patch = contactPersonPatch(description, record.frontmatter, contact.source, implementation, identity);
        setConversion({ patch, path, revision: record.revision, typeName: implementation.typeName });
        return;
      }
      const selected = fresh.people.find((record) => record.path === path);
      if (!selected) throw new Error("Select a person record.");
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
      await freshUnlinkedDirectory();
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
    await freshUnlinkedDirectory();
    assertCurrent();
    await gateway.create(input);
    if (!lifecycle.current?.signal.aborted) { setCreating(false); setRevision((value) => value + 1); }
  }

  return <section ref={panel} id="your-person" tabIndex={-1} aria-label="Your person record">
    <div className="settings-intro"><h2>Your person record</h2><p>Represent yourself using an ordinary note in this collection. This does not change access or membership.</p></div>
    {error && <div className="setting-row"><strong className="settings-alert" role="alert">{error}</strong><button className="settings-secondary-action" type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></div>}
    {identityDenied && <div className="setting-row"><div><h3>Allow the Editor to see your account identity</h3><p>The Editor can link a person record only to an identity you let it read. Approve the Editor again for this collection and allow “See your account identity and display name”.</p></div><button className="settings-secondary-action" type="button" disabled={busy} onClick={() => void allowIdentity()}>{busy ? "Waiting for approval…" : "Review access"}</button></div>}
    {!records && !error && !identityDenied && <p className="settings-note" role="status">Loading your identity and person records…</p>}
    {linked && <div className="setting-row"><div><h3>Linked to {linked.name}</h3><p><code>{linked.path}</code> · Edit this note to change its collection display name or identity associations.</p></div></div>}
    {directory && <ResolutionProblem resolution={directory.me} />}
    {directory && directory.invalid.length > 0 && <details className="settings-details"><summary><span>{directory.invalid.length === 1 ? "1 person record needs attention" : `${directory.invalid.length} person records need attention`}</span><ChevronRight aria-hidden="true" /></summary><ul className="settings-list">{directory.invalid.map((record) => <li key={record.path}><code>{record.path}</code>: {record.reason}</li>)}</ul></details>}
    {records && directory?.me.status === "unlinked" && <>
      <div className="fact-row"><span>Your account</span><strong>{identity?.name}</strong></div>
      <p className="settings-note">The record's display name belongs to this collection and is not synchronised with your account.</p>
      {(records.length > 0 || contacts.length > 0) && <div className="setting-row person-choice"><div><h3>Existing person or contact</h3><p>Link a record that already represents you.</p></div><div className="setting-controls"><Select aria-label="Existing person or contact" value={path} disabled={busy} placeholder="Choose a record…" options={[
        ...records.map((record) => ({ value: record.path, label: `${record.name} · ${record.path}` })),
        ...contacts.map((contact) => ({ value: contact.path, label: `${contact.name} · ${contact.path} (Contact-only)` }))
      ]} onChange={(next) => { setPath(next); setConversion(undefined); setConfirmClaimed(false); }} /><button className="settings-secondary-action" type="button" disabled={!path || busy || !canEdit} onClick={() => void link()}>{contacts.some((contact) => contact.path === path) ? "Review contact conversion" : confirmClaimed ? "Link anyway" : "Link this record to me"}</button></div></div>}
      {selectedIsClaimed && <p className="settings-note settings-warning" role={confirmClaimed ? "alert" : undefined}>This record is already linked to another account. Linking it to yours means you will both see its assignments as your own. Only continue if this record really represents you.</p>}
      {conversion && <div className="settings-review" role="region" aria-label="Review contact conversion"><p>This changes only <code>{conversion.path}</code> to the <strong>{conversion.typeName}</strong> type, which implements both Person and Contact. Its contact information and Markdown body are retained. No other contacts or type definitions are changed.</p><details className="settings-details"><summary><span>Review fields to write</span><ChevronRight aria-hidden="true" /></summary><pre>{JSON.stringify(conversion.patch, null, 2)}</pre></details><div className="settings-review-actions"><button className="settings-secondary-action" type="button" disabled={busy || !canEdit} onClick={() => void convertContact()}>Convert and link this contact</button><button className="settings-quiet-action" type="button" disabled={busy} onClick={() => setConversion(undefined)}>Cancel conversion</button></div></div>}
      {!canEdit && <p className="settings-note">Ask a collection editor to link your person record.</p>}
      {(implementations.length === 0 || outdatedStarter) && <>
        <div className="setting-row">{implementations.length === 0
          ? <div><h3>Person definitions needed</h3><p>This collection needs person definitions before you can create or link a person record. Nothing will be added without your approval.</p></div>
          : <div><h3>Person type update available</h3><p>The <strong>{outdatedStarter!.typeName}</strong> type is an earlier Person starter. Review the current starter before creating your record. Nothing will change without your approval.</p></div>}
          {!setup && <button ref={setupButton} className="settings-secondary-action" type="button" disabled={busy || !canInstall || !onRefreshDescription} onClick={() => void reviewSetup()}>{busy ? "Checking person setup…" : implementations.length === 0 ? "Set up person records" : "Review Person type update"}</button>}</div>
        {!canInstall && <p className="settings-note">Adding definitions requires permission to manage this collection's types.</p>}
        {setup && <section ref={setupPanel} className="settings-review" tabIndex={-1} aria-label="Review person setup">
          {setup.upgrade ? <>
            <h3>Update the Person type?</h3>
            <p>Upgrade <code>{setup.upgrade.target}</code> to the current Person starter. {setup.upgrade.merged
              ? "Your edits to this type are kept; only the starter's own changes are merged in."
              : "It has not been edited since it was added, so it is replaced with the new starter."} Existing notes, other definitions, and access permissions will not be changed.</p>
          </> : <>
            <h3>Allow person records in this collection?</h3>
            <p>Add one Person type, with optional contact details, and its supporting definitions. Existing notes, customized definitions, and access permissions will not be changed.</p>
          </>}
          <details className="settings-details"><summary><span>Review definition files</span><ChevronRight aria-hidden="true" /></summary><ul className="settings-list">{setup.assessment.resources.map((resource) => <li key={resource.target}>{resource.target === setup.upgrade?.target ? "upgrade" : resource.action}: <code>{resource.target}</code></li>)}<li>{setup.assessment.lock.action}: <code>{setup.assessment.lock.target}</code> (setup receipt)</li></ul></details>
          <div className="settings-review-actions"><button className="settings-secondary-action" type="button" disabled={busy || !canInstall} onClick={() => void approveSetup()}>{busy ? (setup.upgrade ? "Updating definitions…" : "Adding definitions…") : setup.upgrade ? "Update definitions and continue" : "Add definitions and continue"}</button><button className="settings-quiet-action" type="button" disabled={busy} onClick={() => setSetup(undefined)}>Not now</button></div>
        </section>}
      </>}
      {implementations.length > 0 && !creating && (canCreate || (canEdit && implementations.length > 1)) && <div className="setting-row person-choice"><div><h3>{canCreate ? "New person record" : "Person type"}</h3><p>{canCreate ? "Create a note for yourself, starting from your account name." : "The type used when linking a record to you."}</p></div><div className="setting-controls">{implementations.length > 1 && <Select aria-label="Person type" value={implementation?.typeName ?? ""} options={implementations.map((item) => ({ value: item.typeName, label: item.typeName }))} onChange={(next) => { setTypeName(next); setConversion(undefined); }} />}{canCreate && <button className="settings-secondary-action" type="button" onClick={() => setCreating(true)}>Create my person record</button>}</div></div>}
      {creating && implementation && identity && <NewNoteComposer key={implementation.typeName} types={description.types.filter((type) => type.name === implementation.typeName)} defaultType={implementation.typeName} initialTitle={identity.name} initialProperties={properties} recordPaths={records.map((record) => record.path)} onCreate={create} onCancel={() => setCreating(false)} />}
      <details className="settings-details"><summary><span>About existing contacts</span><ChevronRight aria-hidden="true" /></summary><p className="settings-note">You can link an existing person directly, or review converting a single contact without changing the rest of your address book. Advanced Person mappings are available in Types; required fields there affect every record of that type.</p></details>
    </>}
  </section>;
}

function ResolutionProblem({ resolution }: { resolution: PersonResolution }) {
  if (resolution.status === "ambiguous") return <div className="settings-note settings-alert" role="alert"><p>Several person records are linked to your account. Edit them so exactly one record represents you:</p><ul className="settings-list">{resolution.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>;
  if (resolution.status === "invalid") return <div className="settings-note settings-alert" role="alert"><p>A person record linked to your account has invalid fields. Fix it before relying on it:</p><ul className="settings-list">{resolution.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></div>;
  return null;
}
