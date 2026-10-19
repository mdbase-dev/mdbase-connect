import React, { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type AuthorityTransfer as AuthorityTransferData,
  type DevicePairing,
  type FileAction,
} from "./api";
import { finishDeniedPairing, initialInstallationCollection, installationAccountLabel, installationRefusal, message, NEW_COLLECTION, pairingInspectionPath } from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";
import { watchPairingPreparation } from "./pairing-progress";
import { Checkbox, CheckboxGroup } from "@mdbase-dev/ui/checkbox";
import { Select } from "@mdbase-dev/ui/select";
import "@mdbase-dev/ui/screens.css";

/** Plain label for an exact non-web app origin shown on the consent screen. */
function appOriginKind(origin: string | undefined): string | null {
  if (origin?.startsWith("capacitor://")) return "mobile app";
  if (origin?.startsWith("chrome-extension://")) return "browser extension";
  return null;
}

const FILE_ACTION_VERBS: Record<FileAction, string> = {list: "see the list of", read: "open", add: "add", replace: "replace", move: "move or rename", delete: "delete"};
/** "add", "add and replace", "add, replace and delete". */
function fileAccessVerbs(actions: readonly FileAction[]): string {
  const verbs = actions.map(action => FILE_ACTION_VERBS[action]);
  return verbs.length < 2 ? verbs.join("") : `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}`;
}
export function Pairing({ pairingId }: { pairingId: string }) {
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [preparationError, setPreparationError] = useState("");
  const [busy, setBusy] = useState(false);
  // The step to repeat after a retryable refusal; cancelled once a refusal no retry can fix.
  const [retry, setRetry] = useState<"approve" | null>(null);
  const [outcome, setOutcome] = useState<"cancelled" | ReturnType<typeof installationRefusal> | null>(null);
  const [collectionIds,setCollectionIds] = useState<string[]>([]);
  const [createCollections,setCreateCollections] = useState(false);
  const [allowReminders,setAllowReminders] = useState(false);
  const [selectedCollectionId,setSelectedCollectionId] = useState("");
  const [collectionSearch,setCollectionSearch] = useState("");
  const [newCollectionName,setNewCollectionName] = useState("");
  const [removingId,setRemovingId] = useState("");
  const [revokingId,setRevokingId] = useState("");
  const [declined,setDeclined] = useState(false);
  const generation = useRef(0);
  const dispatching = useRef(false);
  const accountSelectionSucceeded = useRef(false);
  const cancelPreparation = useRef<(() => void) | null>(null);
  const handBack = useRef(false);
  const inspectionPath = pairingInspectionPath(pairingId, location.search);

  useEffect(() => {
    const current = ++generation.current;
    setPairing(null);
    setCollectionIds([]);
    setCreateCollections(false);
    setAllowReminders(false);
    setSelectedCollectionId("");
    setCollectionSearch("");
    setNewCollectionName("");
    setDeepLink("");
    setError("");
    setRetry(null);
    setOutcome(null);
    setBusy(false);
    setDeclined(false);
    accountSelectionSucceeded.current = false;
    dispatching.current = false;
    api<{ pairing: DevicePairing }>(inspectionPath)
      .then((value) => {
        if (current !== generation.current) return;
        setPairing(value.pairing);
        setCollectionIds([...new Set([...(value.pairing.retained_collection_ids??[]),...(value.pairing.approved_collection_ids??[])])]);
        setSelectedCollectionId(initialInstallationCollection(value.pairing));
        setNewCollectionName(value.pairing.creation?.display_name ?? "");
        setCreateCollections(value.pairing.retained_create_collections || value.pairing.approved_create_collections || value.pairing.requested_create_collections || false);
        setAllowReminders(value.pairing.timer_consent === true);
      })
      .catch((reason) => {
        if (current !== generation.current) return;
        if (reason instanceof ApiError && reason.status === 401)
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
    return () => {
      ++generation.current;
      cancelPreparation.current?.();
      cancelPreparation.current = null;
    };
  }, [pairingId, attempt, inspectionPath]);

  // Read-only portal progress: the SDK owns attestation and approval-receipt
  // polling. Do not make the user manually refresh to discover its device key.
  useEffect(() => {
    setPreparationError("");
    if (!pairing?.installation_device || !pairing.account_selection_confirmed || pairing.attested || pairing.approved_at || outcome) return;
    return watchPairingPreparation<DevicePairing>({
      read: async signal => (await api<{pairing:DevicePairing}>(inspectionPath, {signal})).pairing,
      isDispatching: () => dispatching.current,
      onReady: setPairing,
      onError: reason => setPreparationError(message(reason)),
      onTimeout: () => setPreparationError(`We couldn't prepare ${pairing.connector_name}.`),
    });
  },[pairing,pairingId,inspectionPath,outcome]);
  useEffect(()=>{
    if (!pairing?.installation_device || !pairing.account_selection_confirmed || !pairing.attested || pairing.approved_at || pairing.native_authorization_id || outcome || !pairing.collections?.some(c=>c.kind==="private")) return;
    return watchPairingPreparation({
      read:async signal=>(await api<{pairing:DevicePairing}>(inspectionPath,{signal})).pairing,
      isDispatching:()=>dispatching.current,
      ready:value=>!!value.native_authorization_id || !!value.approved_at,
      onReady:value=>setPairing(value),
      onError:reason=>setPreparationError(message(reason)),
      onTimeout:()=>setPreparationError(`We couldn't prepare ${pairing.connector_name}. Make sure the app is up to date.`),
    });
  },[pairing,inspectionPath,outcome]);

  async function act(action: "approve" | "deny" | "remove-access") {
    if (dispatching.current || !pairing) return;
    const current = generation.current;
    dispatching.current = true;
    setBusy(true);
    setError("");
    setRetry(null);
    setOutcome(null);
    let approvalAttempted = false;
    try {
      let selected = selectedCollectionId;
      let approval = pairing;
      if (action === "approve" && pairing.installation_device && !pairing.file_access) {
        const privateTarget = pairing.collections?.some(c => c.collection_id === selected && c.kind === "private");
        const ready = (value: DevicePairing) => !!(value.account_selection_confirmed && value.attested && value.fingerprint && (!privateTarget || value.native_authorization_id));
        if (!ready(approval)) {
          // Only this explicit confirm may disclose the account to the SDK.
          if (!approval.account_selection_confirmed && !accountSelectionSucceeded.current) {
            await api(`/v1/pairing-requests/${pairingId}/select-account`, { method: "POST" });
            if (current !== generation.current) return;
            // Avoid repeating a successful mutation even if inspection hangs.
            // This is not authority: ready() still requires the server's confirmation.
            accountSelectionSucceeded.current = true;
          }
          approval = await new Promise<DevicePairing>((resolve, reject) => {
            const stop = watchPairingPreparation<DevicePairing>({
              read: async signal => (await api<{pairing:DevicePairing}>(inspectionPath, {signal})).pairing,
              isDispatching: () => false,
              ready: value => ready(value) || !!value.approved_at,
              onReady: resolve,
              onError: reject,
              onTimeout: () => reject(new Error(`We couldn't prepare ${pairing.connector_name}. Keep the app open and try again.`)),
            });
            cancelPreparation.current = () => { stop(); reject(new Error("The original sign-in changed.")); };
          });
          if (current !== generation.current) return;
          setPairing(approval);
          if (approval.approved_at) return;
        }
        if (!installationAccountLabel(pairing) || installationAccountLabel(approval) !== installationAccountLabel(pairing)) throw new Error("The signed-in account changed. Start sign-in again from the app.");
        if (selected !== NEW_COLLECTION && !approval.collections?.some(c => c.collection_id === selected && (c.kind === "private") === !!privateTarget)) throw new Error("This collection is no longer available. Choose a collection again.");
      }
      if (action === "approve" && pairing.installation_device && selected === NEW_COLLECTION) {
        approvalAttempted = true;
        const created = await api<{collection_id:string}>(`/v1/pairing-requests/${pairingId}/collections`, {method:"POST",body:JSON.stringify({display_name:newCollectionName})});
        if (current !== generation.current) return;
        const inspected = await api<{pairing:DevicePairing}>(inspectionPath);
        if (current !== generation.current) return;
        setPairing(inspected.pairing);
        approval = inspected.pairing;
        if (!inspected.pairing.creation?.completed || inspected.pairing.creation.collection_id !== created.collection_id || !inspected.pairing.collections?.some(collection=>collection.collection_id===created.collection_id)) throw new Error("We couldn't confirm collection creation finished. Please try again.");
        selected = created.collection_id;
        setSelectedCollectionId(selected);
        setNewCollectionName(inspected.pairing.creation.display_name);
      }
      const privateChoice=approval.collections?.some(c=>c.collection_id===selected && c.kind==="private")===true;
      const approvedIds = privateChoice ? [] : [...new Set([...collectionIds, selected])].filter(id=>id && !approval.retained_collection_ids?.includes(id));
      if (action === "approve") approvalAttempted = true;
      const result = await api<{ deep_link?: string; native_authorization_uri?:string }>(
        `/v1/pairing-requests/${pairingId}/${action}`,
        { method: "POST", ...(action==="remove-access" ? {body:JSON.stringify({collection_id:removingId,confirm:true})} : action==="approve" && pairing.file_access ? {body:JSON.stringify({fingerprint:pairing.fingerprint,collection_ids:[],file_actions:pairing.file_access.actions})} : action==="approve" && pairing.installation_device ? {body:JSON.stringify({fingerprint:approval.fingerprint,collection_ids:approvedIds,create_collections:!privateChoice && createCollections && !approval.retained_create_collections,selected_collection_id:selected,...(privateChoice?{selected_collection_kind:"private"}:approval.timer_declaration?{timer_consent:allowReminders}:{})})} : {}) },
      );
      if (current !== generation.current) return;
      if (action === "deny" && pairing.file_access) {
        setDeclined(true);
        return;
      }
      if (action === "deny") {
        if (finishDeniedPairing(pairing, window) === "cancelled") setOutcome("cancelled");
        return;
      }
      if (action==="approve" && result.native_authorization_uri) {
        const target=new URL(result.native_authorization_uri,location.origin);
        if (target.origin!==location.origin || target.pathname!=="/oauth/authorize" || target.searchParams.get("request_id")!==approval.native_authorization_id) throw new Error("The original app approval changed.");
        window.location.assign(target.href);
        return;
      }
      if (action === "approve") handBack.current = true;
      if(action==="remove-access"){setRevokingId(removingId);setRemovingId("");}
      if (pairing.installation_device) setAttempt((value) => value + 1);
      else if (result.deep_link) setDeepLink(result.deep_link);
    } catch (reason) {
      // Observe uncertain creation/approval without replaying either mutation.
      // Restore the server's original name/target before an explicit user retry.
      let approved = false;
      if (approvalAttempted && pairing.installation_device && current === generation.current) {
        try {
          const inspected = await api<{pairing:DevicePairing}>(inspectionPath);
          if (current === generation.current) {
            setPairing(inspected.pairing);
            approved = !!inspected.pairing.approved_at;
            if (inspected.pairing.creation && selectedCollectionId === NEW_COLLECTION) {
              setNewCollectionName(inspected.pairing.creation.display_name);
              setSelectedCollectionId(inspected.pairing.creation.completed ? inspected.pairing.creation.collection_id : NEW_COLLECTION);
            }
          }
        } catch { /* Keep the original failure, not a replacement request. */ }
      }
      if (current !== generation.current) return;
      if (approved) setError("");
      else if (action === "approve") {
        const refusal = installationRefusal(reason, pairing.connector_name);
        let windowCancelled = false;
        // Cancel the window so the app stops waiting and can start sign-in again.
        if (refusal.cancel) {
          try { await api(`/v1/pairing-requests/${pairingId}/deny`, { method: "POST" }); windowCancelled = true; }
          catch { /* Keep the window; the user can retry or cancel. */ }
        }
        if (current !== generation.current) return;
        if (refusal.heading) setOutcome(refusal);
        else setError(refusal.message);
        setRetry(windowCancelled ? null : action);
      } else setError(message(reason));
    } finally {
      if (current === generation.current) {
        cancelPreparation.current = null;
        dispatching.current = false;
        setBusy(false);
      }
    }
  }

  // Hand back to the app's declared link once, right after this approval.
  useEffect(() => {
    if (handBack.current && pairing?.approved_at && pairing.return_url) {
      handBack.current = false;
      location.assign(pairing.return_url);
    }
  }, [pairing]);

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
  const refusal = outcome && outcome !== "cancelled" ? outcome : pairing.account_upgrade
    ? installationRefusal({ code: "installation_legacy_backend", details: { upgrade: pairing.account_upgrade } }, pairing.connector_name)
    : null;
  const privateChoice=pairing.collections?.some(c=>c.collection_id===selectedCollectionId && c.kind==="private")===true;
  const collectionQuery = collectionSearch.trim().toLocaleLowerCase();
  const matchingCollections = (pairing.collections ?? []).filter(collection => collection.display_name.toLocaleLowerCase().includes(collectionQuery));
  // Searching narrows candidates, never changes the user's current approval choice.
  const visibleCollections = (pairing.collections ?? []).filter(collection => collection.collection_id === selectedCollectionId || matchingCollections.includes(collection));
  if (installation && !pairing.approved_at && !declined && outcome !== "cancelled" && refusal) {
    return <main className="mdbase-connect-screen installation-approval"><section>
      <PageBrand label="connect" error={error} />
      <h1>{refusal.heading}</h1>
      {installationAccountLabel(pairing) && <p className="installation-account-label">Account: {installationAccountLabel(pairing)}</p>}
      <p className="mdbase-connect-lead" role="alert">{refusal.message}</p>
      {!outcome && <button className="mdbase-button" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Check again</button>}
      {retry && <button className="mdbase-button" disabled={busy} onClick={() => void act(retry)}>Try again</button>}
      {(!outcome || retry) && <div className="decision-actions"><button className="mdbase-button" disabled={busy} onClick={() => void act("deny")}>Cancel</button></div>}
      <p className="mdbase-connect-lead">{pairing.return_url
        ? <a href={pairing.return_url}>Return to {pairing.connector_name}</a>
        : `Return to ${pairing.connector_name}.`}</p>
    </section></main>;
  }
  if (installation && pairing.file_access) {
    const request = pairing.file_access, app = pairing.connector_name;
    const collection = request.collection_name ?? "this collection";
    return (
      <main className="mdbase-connect-screen installation-approval">
        <section>
          <PageBrand label="connect" error={error} />
          {pairing.approved_at ? (
            <>
              <h1>Allowed</h1>
              <p className="mdbase-connect-lead">{app} can now {fileAccessVerbs(request.approved_actions ?? request.actions)} files in {collection}. Return to {app} to continue.</p>
            </>
          ) : declined ? (
            <>
              <h1>Not allowed</h1>
              <p className="mdbase-connect-lead">{app} won't {fileAccessVerbs(request.actions)} files in {collection}. Return to {app}; everything else works as before.</p>
            </>
          ) : (
            <>
              <h1>Allow {app} to {fileAccessVerbs(request.actions)} files?</h1>
              <p className="mdbase-connect-lead">In {collection}. Allow only if you just asked for this in {app}.</p>
              <blockquote className="installation-file-access-reason">
                <p>{app} says: {request.reason}</p>
              </blockquote>
              {installationAccountLabel(pairing) && <p className="installation-account-label">Account: {installationAccountLabel(pairing)}</p>}
              <p className="field-note">mdbase remembers your choice and {app} follows it. {app} keeps its copy of this collection either way.</p>
              <button className="mdbase-button is-primary" disabled={busy || !pairing.fingerprint} onClick={() => void act("approve")}>
                {busy ? "Allowing…" : "Allow"}
              </button>
              <div className="decision-actions">
                <button className="mdbase-button" disabled={busy} onClick={() => void act("deny")}>Don't allow</button>
              </div>
            </>
          )}
        </section>
      </main>
    );
  }
  return (
    <main className={installation ? "mdbase-connect-screen installation-approval" : "center-page"}>
      {!installation && <PageBrand label="Computer pairing" error={error} />}
      <section className={installation ? undefined : "decision-panel"}>
        {installation ? (
          <>
            <PageBrand label="connect" error={error} />
            {outcome === "cancelled" ? (
              <>
                <h1>Sign-in cancelled</h1>
                <p className="mdbase-connect-lead">{pairing.return_url
                  ? <a href={pairing.return_url}>Return to {pairing.connector_name}</a>
                  : `Return to ${pairing.connector_name}.`}</p>
              </>
            ) : pairing.approved_at ? (
              <>
                <h1>Access approved</h1>
                <p className="mdbase-connect-lead">{pairing.return_url
                  ? <a href={pairing.return_url}>Return to {pairing.connector_name}</a>
                  : `Return to ${pairing.connector_name}.`}</p>
                {pairing.timer_declaration && <p role="status">{pairing.timer_consent
                  ? "You allowed reminders for the selected collections."
                  : "Reminders are off. You can turn them on in the app by approving reminders again."}</p>}
              </>
            ) : (
              <>
                <h1>Open {pairing.connector_name}</h1>
                <p className="mdbase-connect-lead">Choose a collection to use in {pairing.connector_name}.</p>
                <p className="installation-account-label">Requested by {pairing.connector_name}{appOriginKind(pairing.app_origin) ? ` (${appOriginKind(pairing.app_origin)})` : ""}{pairing.app_origin?.trim() && <> from <code>{pairing.app_origin}</code></>}. Approve only if you started sign-in in this app.</p>
                {installationAccountLabel(pairing) ? (
                  <p className="installation-account-label">Account: {installationAccountLabel(pairing)}</p>
                ) : (
                  <>
                    <p>We couldn't identify your account. Sign in again to continue.</p>
                    <a className="button secondary link-button installation-account-action" href={`/login?return_to=${encodeURIComponent(location.href)}`}>Sign in again</a>
                  </>
                )}
                {pairing.account_selection_confirmed && !pairing.attested && <p role="status">{preparationError || `Preparing ${pairing.connector_name}…`}</p>}
                    <label className="installation-choice">
                      <span>Find a collection</span>
                      <input type="search" value={collectionSearch} disabled={busy} placeholder="Search by name" onChange={event => setCollectionSearch(event.currentTarget.value)} />
                    </label>
                    <label className="installation-choice">
                      <span>Open in {pairing.connector_name}</span>
                      <select className="installation-collection-list" aria-label={`Open in ${pairing.connector_name}`} disabled={busy} size={6} value={selectedCollectionId}
                        onChange={event => setSelectedCollectionId(event.currentTarget.value)}>
                        <option value="" disabled>Choose a collection</option>
                        {pairing.can_create_collection && !pairing.creation?.completed && <option value={NEW_COLLECTION}>Create a new collection…</option>}
                        {visibleCollections.map(collection => <option key={collection.collection_id} value={collection.collection_id}>{collection.display_name}</option>)}
                      </select>
                    </label>
                    {collectionQuery && matchingCollections.length === 0 && <p role="status">No collections match. Try another name; your current choice stays selected.</p>}
                    {selectedCollectionId === NEW_COLLECTION && <div className="installation-choice">
                      <label htmlFor="installation-collection-name">New collection name</label>
                      <input id="installation-collection-name" aria-describedby="installation-collection-note" value={newCollectionName} maxLength={200} disabled={busy} readOnly={!!pairing.creation} onChange={event=>setNewCollectionName(event.target.value)} />
                      <small id="installation-collection-note">Approve will create this collection and open it in {pairing.connector_name}.</small>
                      {pairing.creation && <small role="status">Creation hasn't finished. Approve continues the same named collection.</small>}
                    </div>}
                    {privateChoice && <p className="field-note">This collection stays on your computer. It can connect when a computer signed in to this account is available.</p>}
                    {privateChoice && !pairing.native_authorization_id && <p role="status">{preparationError || `Preparing ${pairing.connector_name}…`}</p>}
                    <p className="mdbase-connect-footnote">Access includes the notes and files in the collection you pick.{createCollections && !privateChoice ? ` ${pairing.connector_name} can also create new collections for you.` : ""}{pairing.scope_only ? " Previously approved collections stay available." : ""}</p>
                    {!privateChoice && (pairing.collections?.some(c=>c.kind!=="private") || pairing.retained_collection_ids?.length || pairing.requested_create_collections || pairing.retained_create_collections) ? <details className="installation-advanced">
                      <summary>Advanced: allow more collections</summary>
                      <CheckboxGroup legend="Additional collection access" disabled={busy}>
                        {(pairing.collections??[]).filter(c=>c.kind!=="private").map(collection=>(
                          <div key={collection.collection_id}>
                            <Checkbox checked={collection.collection_id===selectedCollectionId || collectionIds.includes(collection.collection_id)} disabled={collection.collection_id===selectedCollectionId || pairing.retained_collection_ids?.includes(collection.collection_id)} onChange={event=>setCollectionIds(ids=>event.target.checked?[...new Set([...ids,collection.collection_id])]:ids.filter(id=>id!==collection.collection_id))}>
                              {collection.display_name}{pairing.retained_collection_ids?.includes(collection.collection_id) ? " (already allowed)" : ""}
                            </Checkbox>
                            {pairing.scope_only && pairing.retained_collection_ids?.includes(collection.collection_id) && <button type="button" className="button secondary installation-account-action" onClick={()=>setRemovingId(collection.collection_id)}>Remove access</button>}
                          </div>
                        ))}
                        {(pairing.retained_collection_ids??[]).filter(id=>!pairing.collections?.some(collection=>collection.collection_id===id)).map(id=><div key={id}><p>Already allowed collection (currently unavailable)</p><button type="button" className="button secondary installation-account-action" onClick={()=>setRemovingId(id)}>Remove access</button></div>)}
                        {(pairing.requested_create_collections || pairing.retained_create_collections) && <Checkbox checked={createCollections} disabled={pairing.retained_create_collections} onChange={event=>setCreateCollections(event.target.checked)}>
                          Allow {pairing.connector_name} to create new collections
                        </Checkbox>}
                      </CheckboxGroup>
                      {pairing.scope_only && <p>Already-allowed access stays in place. Remove access separately if you no longer want it.</p>}
                    </details> : null}
                    {!privateChoice && pairing.timer_declaration && <div className="installation-choice">
                      <Checkbox disabled={busy} checked={allowReminders} onChange={event=>setAllowReminders(event.target.checked)}>
                        Allow {pairing.connector_name} to send you reminders
                      </Checkbox>
                      <p className="field-note">Applies to the collection you chose to open and any new collections selected here. Other collections are not included.</p>
                      {!allowReminders && <p role="status">Reminders will be off. You can finish setup and turn them on later in the app. Collection access stays unchanged.</p>}
                    </div>}
                    {removingId && <div role="group" aria-label="Confirm removal">
                      <p>{pairing.connector_name} will lose access to {pairing.collections?.find(collection=>collection.collection_id===removingId)?.display_name??"this collection"} on all its devices. Previously downloaded data cannot be erased.</p>
                      <button className="button secondary installation-account-action" disabled={busy} onClick={()=>setRemovingId("")}>Keep access</button>
                      <button className="button primary installation-account-action" disabled={busy} onClick={()=>void act("remove-access")}>Remove access</button>
                    </div>}
                    {revokingId && <p role="status">Removing access to {pairing.collections?.find(collection=>collection.collection_id===revokingId)?.display_name??"this collection"}…</p>}
                    <button className="mdbase-button is-primary"
                      disabled={busy || !installationAccountLabel(pairing) || !selectedCollectionId || (selectedCollectionId===NEW_COLLECTION ? !pairing.can_create_collection || !newCollectionName.trim() : !pairing.collections?.some(collection=>collection.collection_id===selectedCollectionId))}
                      onClick={()=>void act("approve")}>
                      {busy ? "Approving…" : "Approve"}
                    </button>
                <div className="decision-actions">
                  <button
                    className="mdbase-button"
                    disabled={busy}
                    onClick={() => void act("deny")}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
            {outcome !== "cancelled" && <details className="installation-details">
              <summary>Details</summary>
              {pairing.app_origin?.trim()
                ? <p>Requested from <code>{pairing.app_origin}</code>. The origin shown here is not proof of who made the request.</p>
                : <p>Requested by {pairing.connector_name}. No requesting origin is available.</p>}
              <p>This device can keep an offline copy of approved collections, including their files and current account/member information. Access applies only to the collections you allow.</p>
              {pairing.fingerprint && <p>Device key: <code>{pairing.fingerprint}</code></p>}
            </details>}
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
            {retry && !busy && <button className="mdbase-button installation-account-action" onClick={() => void act(retry)}>Try again</button>}
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
