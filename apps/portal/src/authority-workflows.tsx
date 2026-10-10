import React, { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type AuthorityTransfer as AuthorityTransferData,
} from "./api";
import { message } from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";
import { Select } from "@mdbase-dev/ui/select";

interface DevicePairing {
  connector_name: string;
  approved_at: string | null;
  installation_device?: boolean;
  kind?: "app-runtime" | "mobile";
  account_selected?: boolean;
  account_selection_confirmed?: boolean;
  account_email?: string;
  signed_in_account_email?: string;
  selected_collection_id?: string | null;
  can_create_collection?: boolean;
  creation?: {collection_id:string;display_name:string;completed:boolean} | null;
  attested?: boolean;
  fingerprint?: string | null;
  app_origin?: string;
  requested_create_collections?: boolean;
  approved_create_collections?: boolean;
  approved_collection_ids?: string[];
  scope_only?: boolean;
  retained_collection_ids?: string[];
  retained_create_collections?: boolean;
  collections?: Array<{collection_id:string;display_name:string;role:string}>;
}
export function Pairing({ pairingId }: { pairingId: string }) {
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [collectionIds,setCollectionIds] = useState<string[]>([]);
  const [createCollections,setCreateCollections] = useState(false);
  const [selectedCollectionId,setSelectedCollectionId] = useState("");
  const [newCollectionName,setNewCollectionName] = useState("");
  const [removingId,setRemovingId] = useState("");
  const [revokingId,setRevokingId] = useState("");
  const generation = useRef(0);
  const dispatching = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    setPairing(null);
    setCollectionIds([]);
    setCreateCollections(false);
    setSelectedCollectionId("");
    setNewCollectionName("");
    setDeepLink("");
    setError("");
    setBusy(false);
    dispatching.current = false;
    api<{ pairing: DevicePairing }>(`/v1/pairing-requests/${pairingId}`)
      .then((value) => {
        if (current !== generation.current) return;
        setPairing(value.pairing);
        const createdId = value.pairing.creation?.completed ? value.pairing.creation.collection_id : "";
        setCollectionIds([...new Set([...(value.pairing.retained_collection_ids??[]),...(value.pairing.approved_collection_ids??[]),...(createdId?[createdId]:[])])]);
        setSelectedCollectionId(value.pairing.selected_collection_id ?? createdId);
        setNewCollectionName(value.pairing.creation?.display_name ?? "");
        setCreateCollections(value.pairing.retained_create_collections || value.pairing.approved_create_collections || false);
      })
      .catch((reason) => {
        if (current !== generation.current) return;
        if (reason instanceof ApiError && reason.status === 401)
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
    return () => {
      ++generation.current;
    };
  }, [pairingId, attempt]);

  // Read-only portal progress: the SDK owns attestation and approval-receipt
  // polling. Do not make the user manually refresh to discover its device key.
  useEffect(() => {
    if (!pairing?.installation_device || !pairing.account_selection_confirmed || pairing.attested || pairing.approved_at) return;
    const current = generation.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (cancelled || current!==generation.current) return;
      if (dispatching.current) {timer=setTimeout(()=>void poll(),1000);return;}
      try {
        const value=await api<{pairing:DevicePairing}>(`/v1/pairing-requests/${pairingId}`);
        if (cancelled || current!==generation.current) return;
        if (value.pairing.attested || value.pairing.approved_at) {setPairing(value.pairing);return;}
        timer=setTimeout(()=>void poll(),1000);
      } catch (reason) {
        if (!cancelled && current===generation.current) setError(message(reason));
      }
    }
    timer=setTimeout(()=>void poll(),1000);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[pairing,pairingId]);

  async function act(action: "approve" | "select-account" | "deny" | "remove-access") {
    if (dispatching.current || !pairing) return;
    const current = generation.current;
    dispatching.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ deep_link?: string }>(
        `/v1/pairing-requests/${pairingId}/${action}`,
        { method: "POST", ...(action==="remove-access" ? {body:JSON.stringify({collection_id:removingId,confirm:true})} : action==="approve" && pairing.installation_device ? {body:JSON.stringify({fingerprint:pairing.fingerprint,collection_ids:collectionIds.filter(id=>!pairing.retained_collection_ids?.includes(id)),create_collections:createCollections && !pairing.retained_create_collections,selected_collection_id:selectedCollectionId})} : {}) },
      );
      if (current !== generation.current) return;
      if (action === "deny") {
        location.href = "/";
        return;
      }
      if(action==="remove-access"){setRevokingId(removingId);setRemovingId("");}
      if (pairing.installation_device) setAttempt((value) => value + 1);
      else if (result.deep_link) setDeepLink(result.deep_link);
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (current === generation.current) {
        dispatching.current = false;
        setBusy(false);
      }
    }
  }

  async function createNamedCollection() {
    if (dispatching.current || !pairing || !newCollectionName.trim()) return;
    const current = generation.current;
    dispatching.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/pairing-requests/${pairingId}/collections`,{method:"POST",body:JSON.stringify({display_name:newCollectionName})});
      if (current===generation.current) setAttempt(value=>value+1);
    } catch (reason) {
      if (current===generation.current) setError(message(reason));
    } finally {
      if (current===generation.current) {dispatching.current=false;setBusy(false);}
    }
  }

  if (!pairing)
    return (
      <Loading
        error={error}
        onRetry={() => {
          if (error) setAttempt((value) => value + 1);
        }}
      />
    );
  const installation = pairing.installation_device === true;
  return (
    <main className="center-page">
      <PageBrand
        label={installation ? "Device sign-in" : "Computer pairing"}
        error={error}
      />
      <section className="decision-panel">
        {installation ? (
          <>
            {pairing.approved_at ? (
              <>
                <h1>{pairing.scope_only ? "Collection access approved" : "Device approved"}</h1>
                <p>
                  Return to {pairing.connector_name}. It will finish securely.
                  No device credential was displayed or copied.
                </p>
              </>
            ) : (
              <>
                <p className="eyebrow">
                  {pairing.scope_only ? "Update collection access" : pairing.kind === "mobile"
                    ? "New app device"
                    : "New browser device"}
                </p>
                <h1>{pairing.connector_name}</h1>
                <p>Requested from <code>{pairing.app_origin}</code></p>
                <p>
                  Approve only if you started sign-in in this app right now.
                  The origin shown here is not proof of who made the request.
                </p>
                <p>Account: {pairing.account_email ?? pairing.signed_in_account_email}</p>
                {!pairing.account_selection_confirmed ? (
                  <>
                    <p>
                      Select your signed-in account for this device. This does
                      not approve access yet.
                    </p>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() => void act("select-account")}
                    >
                      Use this account
                    </button>
                  </>
                ) : !pairing.attested ? (
                  <>
                    <p>
                      The app is preparing its protected device key. This page
                      updates automatically. No access has been approved.
                    </p>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      Check device key
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      {pairing.scope_only ? "Keep this device and update its access." : "Approve this installation as a device."} It can open and keep an offline replica of only the collections you select, including their files and current account/member identity information. This is not an application grant.
                    </p>
                    <p>
                      Device key: <code>{pairing.fingerprint}</code>
                    </p>
                    <label className="installation-choice">
                      <span>Collection to open in {pairing.connector_name}</span>
                      <Select aria-label="Collection to open" disabled={busy} value={selectedCollectionId}
                        options={[{value:"",label:"Choose a collection"},...(pairing.collections??[]).map(collection=>({value:collection.collection_id,label:collection.display_name}))]}
                        onChange={id=>{setSelectedCollectionId(id);if(id)setCollectionIds(ids=>[...new Set([...ids,id])]);}} />
                    </label>
                    {pairing.can_create_collection && !pairing.creation?.completed && <div className="installation-choice">
                      <label htmlFor="installation-collection-name">New collection name</label>
                      <input id="installation-collection-name" value={newCollectionName} maxLength={200} disabled={busy} readOnly={!!pairing.creation} onChange={event=>setNewCollectionName(event.target.value)} />
                      <p className="field-note">Create an empty cloud-copy collection in this account. This does not approve app access or set it up.</p>
                      <button type="button" className="button secondary" disabled={busy || !newCollectionName.trim()} onClick={()=>void createNamedCollection()}>
                        {pairing.creation ? "Resume named collection creation" : "Create named collection"}
                      </button>
                      {pairing.creation && <p role="status">Creation is incomplete. Resume the same collection; do not start another.</p>}
                    </div>}
                    <fieldset className="installation-scopes" disabled={busy}>
                      <legend>Entire collections</legend>
                      {(pairing.collections??[]).map(collection=>(
                        <div key={collection.collection_id}>
                        <label>
                          <input type="checkbox" className="mdbase-checkbox" checked={collectionIds.includes(collection.collection_id)} disabled={pairing.retained_collection_ids?.includes(collection.collection_id)} onChange={event=>{setCollectionIds(ids=>event.target.checked?[...ids,collection.collection_id]:ids.filter(id=>id!==collection.collection_id));if(!event.target.checked && selectedCollectionId===collection.collection_id)setSelectedCollectionId("");}} />
                          <span>{collection.display_name} ({collection.role})</span>
                          <code>{collection.collection_id}</code>
                        </label>
                        {pairing.scope_only && pairing.retained_collection_ids?.includes(collection.collection_id) && <button type="button" className="button secondary" onClick={()=>setRemovingId(collection.collection_id)}>Remove access</button>}
                        </div>
                      ))}
                      {(pairing.retained_collection_ids??[]).filter(id=>!pairing.collections?.some(collection=>collection.collection_id===id)).map(id=><div key={id}><p>Already approved: <code>{id}</code> (currently unavailable)</p><button type="button" className="button secondary" onClick={()=>setRemovingId(id)}>Remove access</button></div>)}
                      {!pairing.collections?.length && <p>No current cloud-copy collections are available.</p>}
                      {(pairing.requested_create_collections || pairing.retained_create_collections) && <label>
                        <input type="checkbox" className="mdbase-checkbox" checked={createCollections} disabled={pairing.retained_create_collections} onChange={event=>setCreateCollections(event.target.checked)} />
                        <span>Create new collections</span>
                      </label>}
                    </fieldset>
                    {pairing.scope_only && <p>Already-approved access stays in place. Removal is a separate revocation, not part of re-consent.</p>}
                    {removingId && <div role="group" aria-label="Confirm removal">
                      <p>This app will lose access to {pairing.collections?.find(collection=>collection.collection_id===removingId)?.display_name??removingId} on all its devices. Those devices cannot rejoin this collection; previously downloaded data cannot be erased.</p>
                      <button className="button secondary" disabled={busy} onClick={()=>setRemovingId("")}>Keep access</button>
                      <button className="button primary" disabled={busy} onClick={()=>void act("remove-access")}>Remove access to this collection</button>
                    </div>}
                    {revokingId && <p role="status">Revoking this app's access to <code>{revokingId}</code>. New access requests are refused immediately; device access is being revoked in the collection log.</p>}
                    <p>Other existing or future collections are not included. {pairing.requested_create_collections ? "If approved, only collections created by this installation are added to its access automatically." : "This app has not requested permission to create collections."}</p>
                    <button
                      className="button primary"
                      disabled={busy || !pairing.fingerprint || !selectedCollectionId || !collectionIds.includes(selectedCollectionId) || !pairing.collections?.some(collection=>collection.collection_id===selectedCollectionId)}
                      onClick={() => void act("approve")}
                    >
                      {pairing.scope_only ? "Approve collection access" : "Approve this device"}
                    </button>
                  </>
                )}
                <div className="decision-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void act("deny")}
                  >
                    Deny device
                  </button>
                </div>
              </>
            )}
          </>
        ) : deepLink ? (
          <>
            <p className="eyebrow">Computer approved</p>
            <h1>Return to mdbase connect.</h1>
            <p>
              The desktop app will finish securely. No connector token was
              displayed or copied.
            </p>
            <a className="button primary link-button" href={deepLink}>
              Open mdbase connect
            </a>
          </>
        ) : (
          <>
            <p className="eyebrow">New computer</p>
            <h1>{pairing.connector_name}</h1>
            <p>
              Allow this computer to connect to your account. It will publish
              collection names and route application requests, but not local
              folder paths.
            </p>
            <div className="decision-actions">
              <a className="button secondary link-button" href="/">
                Cancel
              </a>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void act("approve")}
              >
                Approve computer
              </button>
            </div>
          </>
        )}
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
      </section>
    </main>
  );
}

export function MirrorPairing({ pairingId }: { pairingId: string }) {
  const [request, setRequest] = useState<{
    pairing: {
      mirror_name: string;
      mode: "read_only" | "read_write";
      collection_hint?: string | null;
      collection_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    };
    collections: Array<{ id: string; display_name: string }>;
  } | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setRequest(null);
    setError("");
    api<NonNullable<typeof request>>(`/v1/mirror-pairing-requests/${pairingId}`)
      .then((value) => {
        if (!active) return;
        setError("");
        setRequest(value);
        setApproved(Boolean(value.pairing.approved_at));
        const preferred = value.collections.some(
          (collection) => collection.id === value.pairing.collection_hint,
        )
          ? value.pairing.collection_hint!
          : (value.collections[0]?.id ?? "");
        setCollectionId(value.pairing.collection_id ?? preferred);
      })
      .catch((reason) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) {
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        } else {
          setError(message(reason));
        }
      });
    return () => {
      active = false;
    };
  }, [pairingId, attempt]);

  async function approve() {
    if (!collectionId) return;
    setBusy(true);
    try {
      await api(`/v1/mirror-pairing-requests/${pairingId}/approve`, {
        method: "POST",
        body: JSON.stringify({ collection_id: collectionId }),
      });
      setApproved(true);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!request)
    return (
      <Loading
        error={error}
        onRetry={() => {
          if (error) {
            setError("");
            setAttempt((value) => value + 1);
          }
        }}
      />
    );
  const selected = request.collections.find(
    (collection) => collection.id === collectionId,
  );
  return (
    <main className="center-page">
      <PageBrand label="Folder sync" busy={busy} error={error} />
      <section className="decision-panel">
        {approved ? (
          <>
            <p className="eyebrow outcome-label">Folder approved</p>
            <h1>Return to your computer.</h1>
            <p>
              {selected?.display_name ?? "The collection"} will begin syncing
              automatically. You can close this page.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">New synced folder</p>
            <h1>{request.pairing.mirror_name}</h1>
            <p>
              {request.pairing.mode === "read_write"
                ? "Markdown edits will sync in both directions. Concurrent edits remain separate until you choose a version."
                : "This folder will receive Markdown from mdbase and will not upload local edits."}
            </p>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            {request.collections.length ? (
              <>
                <label>
                  <span>Hosted collection</span>
                  <Select
                    aria-label="Hosted collection"
                    value={collectionId}
                    options={request.collections.map((collection) => ({
                      value: collection.id,
                      label: collection.display_name,
                    }))}
                    onChange={setCollectionId}
                  />
                </label>
                <p className="field-note">
                  Existing Markdown is checked before upload. Collection paths
                  and device credentials stay off the control plane.
                </p>
                <div className="decision-actions">
                  <a className="button secondary link-button" href="/">
                    Cancel
                  </a>
                  <button
                    className="button primary"
                    disabled={busy || !collectionId}
                    onClick={() => void approve()}
                  >
                    {busy ? "Approving…" : "Sync this collection"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="message">
                  Create a hosted collection before approving this folder.
                </div>
                <div className="decision-actions">
                  <a className="button primary link-button" href="/">
                    Open your collections
                  </a>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

export function AuthorityAdoption({ adoptionId }: { adoptionId: string }) {
  const [adoption, setAdoption] = useState<{
    id: string;
    collection_id: string;
    display_name: string;
    source_name: string;
    retain_mirror: boolean;
    mirror_name: string | null;
    state:
      | "requested"
      | "approved"
      | "prepared"
      | "activating"
      | "completed"
      | "cancelled"
      | "expired";
    authority_epoch: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const result = await api<{ adoption: NonNullable<typeof adoption> }>(
        `/v1/authority-adoptions/${adoptionId}`,
      );
      setAdoption(result.adoption);
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else {
        setError(message(reason));
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [adoptionId]);

  async function approve() {
    setBusy(true);
    try {
      const result = await api<{ adoption: NonNullable<typeof adoption> }>(
        `/v1/authority-adoptions/${adoptionId}/approve`,
        { method: "POST", body: "{}" },
      );
      setAdoption(result.adoption);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!adoption) return <Loading error={error} />;
  const inactive =
    adoption.state === "cancelled" || adoption.state === "expired";
  return (
    <main className="center-page">
      <PageBrand label="Move collection online" busy={busy} error={error} />
      <section className="decision-panel authority-decision">
        {adoption.state === "completed" ? (
          <>
            <p className="eyebrow outcome-label">Move complete</p>
            <h1>{adoption.display_name} is now hosted.</h1>
            <p>
              mdbase now keeps the main copy of this collection.
              {adoption.retain_mirror
                ? ` ${adoption.mirror_name ?? adoption.source_name} will continue as a synced folder, with edits syncing both ways.`
                : " The original local files are no longer the main copy."}
            </p>
            <div className="transfer-status" role="status">
              <span className="status-dot connected" aria-hidden="true" />
              <span>Main copy hosted by mdbase</span>
            </div>
            <a className="button primary link-button" href="/">
              Return to your account
            </a>
          </>
        ) : inactive ? (
          <>
            <p className="eyebrow">Move ended</p>
            <h1>Your local collection was kept.</h1>
            <p>The main copy was not moved to mdbase.</p>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            <a className="button primary link-button" href="/">
              Return to your account
            </a>
          </>
        ) : adoption.state !== "requested" ? (
          <>
            <p className="eyebrow outcome-label">Move approved</p>
            <h1>Return to {adoption.source_name}.</h1>
            <p>
              The app is uploading and checking a final collection snapshot. The
              main copy will move only after that exact snapshot is complete.
            </p>
            <div className="transfer-status" role="status">
              <span className="status-dot paused" aria-hidden="true" />
              <span>
                {adoption.state === "activating"
                  ? "Finishing the move"
                  : "Waiting for the app"}
              </span>
            </div>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="eyebrow">Move a local collection to mdbase</p>
            <h1>{adoption.display_name}</h1>
            <p>
              Approving uploads the complete collection from{" "}
              {adoption.source_name}, validates it as one snapshot, and then
              makes the hosted version the main copy.
            </p>
            <div className="message">
              {adoption.retain_mirror
                ? `After the move, ${adoption.mirror_name ?? adoption.source_name} stays as a synced folder. It will not be a second main copy.`
                : "After the move, the original local files are no longer the main copy."}
            </div>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <a className="button secondary link-button" href="/">
                Cancel
              </a>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                {busy ? "Approving…" : "Move this collection"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export function AuthorityTransfer({ transferId }: { transferId: string }) {
  const [transfer, setTransfer] = useState<AuthorityTransferData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const result = await api<{ transfer: AuthorityTransferData }>(
        `/v1/authority-transfers/${transferId}`,
      );
      setTransfer(result.transfer);
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else {
        setError(message(reason));
      }
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [transferId]);

  async function approve() {
    setBusy(true);
    try {
      const result = await api<{ transfer: AuthorityTransferData }>(
        `/v1/authority-transfers/${transferId}/approve`,
        { method: "POST", body: "{}" },
      );
      setTransfer(result.transfer);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      await api(`/v1/authority-transfers/${transferId}`, { method: "DELETE" });
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!transfer) return <Loading error={error} />;
  const collectionName = transfer.collection_name ?? "This collection";
  const mirrorName = transfer.mirror_name ?? "the selected computer";
  const waiting =
    transfer.state === "approved" || transfer.state === "prepared";
  const inactive =
    transfer.state === "cancelled" || transfer.state === "expired";
  return (
    <main className="center-page">
      <PageBrand label="Move main copy" busy={busy} error={error} />
      <section className="decision-panel authority-decision">
        {transfer.state === "completed" ? (
          <>
            <p className="eyebrow outcome-label">Transfer complete</p>
            <h1>{collectionName} now lives on your computer.</h1>
            <p>
              The folder on {mirrorName} is now the main copy. Hosted access has
              stopped and previous application connections were revoked.
            </p>
            <div className="transfer-status" role="status">
              <span className="status-dot connected" aria-hidden="true" />
              <span>Main copy on {mirrorName}</span>
            </div>
            <a className="button primary link-button" href="/">
              Return to your account
            </a>
          </>
        ) : inactive ? (
          <>
            <p className="eyebrow">Transfer ended</p>
            <h1>The main copy stayed hosted.</h1>
            <p>{collectionName} remains hosted. Its main copy did not move.</p>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            <a className="button primary link-button" href="/">
              Return to your account
            </a>
          </>
        ) : waiting ? (
          <>
            <p className="eyebrow outcome-label">Transfer approved</p>
            <h1>Return to {mirrorName}.</h1>
            <p>
              mdbase connect is checking the latest hosted changes, registering
              the folder, and making it the main copy.
            </p>
            <div className="transfer-status" role="status">
              <span className="status-dot paused" aria-hidden="true" />
              <span>
                {transfer.state === "prepared"
                  ? "Hosted writes are paused"
                  : "Waiting for the computer"}
              </span>
            </div>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <button
                className="quiet-danger"
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel transfer
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="eyebrow">Move the main copy</p>
            <h1>Use the folder on {mirrorName} as the main copy?</h1>
            <p>
              {collectionName} will stop being hosted and become a
              computer-owned collection. This changes where every future edit is
              accepted.
            </p>
            <dl className="transfer-consequences">
              <div>
                <dt>Folder</dt>
                <dd>The synced Markdown folder becomes the main copy.</dd>
              </div>
              <div>
                <dt>Hosted service</dt>
                <dd>
                  Writes pause during verification, then hosted access is
                  retired.
                </dd>
              </div>
              <div>
                <dt>Applications</dt>
                <dd>
                  Existing access is revoked. Connect applications again to use
                  the local collection.
                </dd>
              </div>
              <div>
                <dt>Recovery</dt>
                <dd>
                  If verification fails or this request expires, hosted writes
                  resume.
                </dd>
              </div>
            </dl>
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void cancel()}
              >
                Keep it hosted
              </button>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                {busy ? "Approving…" : "Move main copy"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
