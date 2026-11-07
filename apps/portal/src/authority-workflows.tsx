import { StatusGlyph } from "@mdbase/connect-ui/status-glyph";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useRef, useState } from "react";
import { literal } from "./literal";
import {
  api,
  ApiError,
  type AuthorityTransfer as AuthorityTransferData,
  type DevicePairing,
} from "./api";
import { finishDeniedPairing, rememberCollection, installationAccountLabel, installationRefusal, message, NEW_COLLECTION, pairingInspectionPath } from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";
import { CollectionPicker, CollectionIdentity, RequestShell, fileActionLabel, useRequestExpiry } from "./authorization-review";
import { RequestIdentity, RequestOutcome } from "./authorization-view";
import { watchPairingCollections, watchPairingPreparation } from "./pairing-progress";
import { Checkbox, CheckboxGroup } from "@mdbase-dev/ui/checkbox";
import { Select } from "@mdbase-dev/ui/select";
type PairingRequest = DevicePairing & { expires_at?: string };

export function Pairing({ pairingId }: { pairingId: string }) {
  useLocaleRevision();
  const [pairing, setPairing] = useState<PairingRequest | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [preparationError, setPreparationError] = useState("");
  const [busy, setBusy] = useState(false);
  // The step to repeat after a retryable refusal; cancelled once a refusal no retry can fix.
  const [retry, setRetry] = useState<"approve" | null>(null);
  const [outcome, setOutcome] = useState<"cancelled" | "expired" | ReturnType<typeof installationRefusal> | null>(null);
  const [collectionIds,setCollectionIds] = useState<string[]>([]);
  const [createCollections,setCreateCollections] = useState(false);
  const [allowReminders,setAllowReminders] = useState(false);
  const [selectedCollectionId,setSelectedCollectionId] = useState("");
  const [newCollectionName,setNewCollectionName] = useState("");
  const [removingId,setRemovingId] = useState("");
  const [revokingId,setRevokingId] = useState("");
  const [declined,setDeclined] = useState(false);
  const generation = useRef(0);
  const dispatching = useRef(false);
  const accountSelectionSucceeded = useRef(false);
  const cancelPreparation = useRef<(() => void) | null>(null);
  const handBack = useRef(false);
  const approvalTarget = useRef<HTMLDivElement>(null);
  const inspectionPath = pairingInspectionPath(pairingId, location.search);

  useRequestExpiry(pairing && !pairing.approved_at && !declined && !busy && !outcome ? pairing.expires_at : undefined, () => setOutcome("expired"));

  function applyPairing(value: DevicePairing, current: number) {
    if (current !== generation.current) return;
    setPairing(value);
    setCollectionIds([...new Set([...(value.retained_collection_ids ?? []), ...(value.approved_collection_ids ?? [])])]);
    setSelectedCollectionId(value.creation && !value.creation.completed ? NEW_COLLECTION
      : value.selected_collection_id || value.creation?.collection_id || "");
    setNewCollectionName(value.creation?.display_name ?? "");
    setCreateCollections(value.retained_create_collections || value.approved_create_collections || value.requested_create_collections || false);
    setAllowReminders(value.timer_consent === true);
  }

  useEffect(() => {
    const current = ++generation.current;
    setPairing(null);
    setCollectionIds([]);
    setCreateCollections(false);
    setAllowReminders(false);
    setSelectedCollectionId("");
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
      .then(value => applyPairing(value.pairing, current))
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

  useEffect(() => {
    if (!pairing?.installation_device || pairing.approved_at || outcome || busy) return;
    return watchPairingCollections({
      read: async signal => (await api<{ pairing: DevicePairing }>(inspectionPath, { signal })).pairing.collections,
      isDispatching: () => dispatching.current,
      onCollections: collections => setPairing(previous => !previous || JSON.stringify(previous.collections) === JSON.stringify(collections)
        ? previous : { ...previous, collections }),
    });
  }, [pairing?.installation_device, pairing?.approved_at, outcome, busy, inspectionPath]);

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
      onTimeout: () => setPreparationError(t(i18n)`We couldn't prepare ${pairing.connector_name}.`),
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
      onTimeout:()=>setPreparationError(t(i18n)`We couldn't prepare ${pairing.connector_name}. Make sure the app is up to date.`),
    });
  },[pairing,inspectionPath,outcome]);

  async function act(action: "approve" | "deny" | "remove-access") {
    if (dispatching.current || !pairing) return;
    if (!pairing.approved_at && pairing.expires_at && Date.parse(pairing.expires_at) <= Date.now()) {
      setOutcome("expired");
      return;
    }
    const current = generation.current;
    dispatching.current = true;
    if (action === "approve" || action === "deny") approvalTarget.current?.focus();
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
              onTimeout: () => reject(new Error(t(i18n)`We couldn't prepare ${pairing.connector_name}. Keep the app open and try again.`)),
            });
            cancelPreparation.current = () => { stop(); reject(new Error(t(i18n)({ message: "The original sign-in changed." }))); };
          });
          if (current !== generation.current) return;
          setPairing(approval);
          if (approval.approved_at) return;
        }
        if (!installationAccountLabel(pairing) || installationAccountLabel(approval) !== installationAccountLabel(pairing)) throw new Error(t(i18n)({ message: "The signed-in account changed. Start sign-in again from the app." }));
        if (selected !== NEW_COLLECTION && !approval.collections?.some(c => c.collection_id === selected && (c.kind === "private") === !!privateTarget)) throw new Error(t(i18n)({ message: "This collection is no longer available. Choose a collection again." }));
      }
      if (action === "approve" && pairing.installation_device && selected === NEW_COLLECTION) {
        approvalAttempted = true;
        const created = await api<{collection_id:string}>(`/v1/pairing-requests/${pairingId}/collections`, {method:"POST",body:JSON.stringify({display_name:newCollectionName})});
        if (current !== generation.current) return;
        const inspected = await api<{pairing:DevicePairing}>(inspectionPath);
        if (current !== generation.current) return;
        setPairing(inspected.pairing);
        approval = inspected.pairing;
        if (!inspected.pairing.creation?.completed || inspected.pairing.creation.collection_id !== created.collection_id || !inspected.pairing.collections?.some(collection=>collection.collection_id===created.collection_id)) throw new Error(t(i18n)({ message: "We couldn't confirm collection creation finished. Please try again." }));
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
      if (action === "approve" && pairing.installation_device && !pairing.file_access) rememberCollection(selected);
      if (action==="approve" && result.native_authorization_uri) {
        const target=new URL(result.native_authorization_uri,location.origin);
        if (target.origin!==location.origin || target.pathname!=="/oauth/authorize" || target.searchParams.get("request_id")!==approval.native_authorization_id) throw new Error(t(i18n)({ message: "The original app approval changed." }));
        window.location.assign(target.href);
        return;
      }
      if (action === "approve") handBack.current = true;
      if(action==="remove-access"){setRevokingId(removingId);setRemovingId("");}
      if (pairing.installation_device) {
        try {
          const inspected = await api<{ pairing: DevicePairing }>(inspectionPath);
          applyPairing(inspected.pairing, current);
        } catch (reason) {
          if (current !== generation.current) return;
          setPairing(null);
          if (reason instanceof ApiError && reason.status === 401)
            location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
          else setAttempt(value => value + 1);
        }
      }
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

  if (!pairing)
    return (
      <RequestShell busy={!error}>
        <h1><Trans>Review app access</Trans></h1>
        <p role={error ? "alert" : "status"}>{error || t(i18n)`Loading the request…`}</p>
        {error && <button className="mdbase-button is-primary" onClick={() => setAttempt(value => value + 1)}><Trans>Try again</Trans></button>}
      </RequestShell>
    );
  const installation = pairing.installation_device === true;
  if (outcome === "expired") return <RequestShell><RequestOutcome status="expired" applicationName={pairing.connector_name} returnUrl="" standalone /></RequestShell>;
  const refusal = outcome && outcome !== "cancelled" ? outcome : pairing.account_upgrade
    ? installationRefusal({ code: "installation_legacy_backend", details: { upgrade: pairing.account_upgrade } }, pairing.connector_name)
    : null;
  const selectedCollection=pairing.collections?.find(collection=>collection.collection_id===selectedCollectionId);
  const privateChoice=selectedCollection?.kind==="private";
  const details = <details className="mdbase-disclosure installation-details">
                      <summary><Trans>Details</Trans></summary>
                      {pairing.app_origin?.trim()
                        ? <p><Trans>Requested from <code>{literal(pairing.app_origin)}</code>. The origin shown here is not proof of who made the request.</Trans></p>
                        : <p><Trans>Requested by {literal(pairing.connector_name)}. No requesting origin is available.</Trans></p>}
                      {pairing.fingerprint && <p><Trans>Device key: <code>{pairing.fingerprint}</code></Trans></p>}
                      <p><Trans>This device can keep an offline copy of approved collections, including their files and current account/member information. Access applies only to the collections you allow.</Trans></p>
                    </details>;
  const selectedName=selectedCollectionId===NEW_COLLECTION ? newCollectionName.trim() || t(i18n)({ message: "a new collection", context: "Collection connection" }) : selectedCollection?.display_name;
  if (installation && !pairing.approved_at && !declined && outcome !== "cancelled" && refusal) {
    return <RequestShell>
      <h1>{refusal.heading}</h1>
      {installationAccountLabel(pairing) && <p className="installation-account-label"><Trans>Account: {literal(installationAccountLabel(pairing))}</Trans></p>}
      <p className="mdbase-connect-lead" role="alert">{refusal.message}</p>
      <footer className="approval-footer">
        {pairing.return_url && <p className="approval-receipt"><a href={pairing.return_url}><Trans>Return to {literal(pairing.connector_name)}</Trans></a></p>}
        <div className="approval-actions">
          {(!outcome || retry) && <button className="mdbase-button is-secondary" disabled={busy} onClick={() => void act("deny")}><Trans>Cancel</Trans></button>}
          {!outcome && <button className="mdbase-button is-primary" disabled={busy} onClick={() => setAttempt(value => value + 1)}><Trans>Check again</Trans></button>}
          {retry && <button className="mdbase-button is-primary" disabled={busy} onClick={() => void act(retry)}><Trans>Try again</Trans></button>}
        </div>
      </footer>
    </RequestShell>;
  }
  if (installation && pairing.file_access) {
    const request = pairing.file_access, app = pairing.connector_name;
    const collection = request.collection_name ?? t(i18n)({ message: "this collection", context: "Collection connection" });
    const actions = pairing.approved_at ? request.approved_actions ?? request.actions : request.actions;
    const permissions = <ul className="field-note">{actions.map(action =>
      <li key={action}>{fileActionLabel(action)}</li>)}</ul>;
    return (
      <RequestShell>
          {pairing.approved_at ? (
            <>
              <h1><Trans>Allowed</Trans></h1>
              <p className="mdbase-connect-lead">{t(i18n)`${app} now has this file access in ${collection}. Return to ${app} to continue.`}</p>
              {permissions}
            </>
          ) : declined ? (
            <>
              <h1><Trans>Not allowed</Trans></h1>
              <p className="mdbase-connect-lead">{t(i18n)`${app} was not given this file access in ${collection}. Return to ${app}; everything else works as before.`}</p>
              {permissions}
            </>
          ) : (
            <>
              <h1>{t(i18n)`Allow ${app} this file access?`}</h1>
              <p className="mdbase-connect-lead">{t(i18n)`In ${collection}. Allow only if you just asked for this in ${app}.`}</p>
              {permissions}
              <blockquote className="installation-file-access-reason">
                <p>{t(i18n)`${app} says: ${request.reason}`}</p>
              </blockquote>
              {installationAccountLabel(pairing) && <p className="installation-account-label"><Trans>Account: {literal(installationAccountLabel(pairing))}</Trans></p>}
              <p className="field-note">{t(i18n)`mdbase remembers your choice and ${app} follows it. ${app} keeps its copy of this collection either way.`}</p>
              <button className="mdbase-button is-primary" disabled={busy || !pairing.fingerprint} onClick={() => void act("approve")}>
                {busy ? t(i18n)({ message: "Allowing…", context: "Collection connection" }) : t(i18n)({ message: "Allow", context: "Collection connection" })}
              </button>
              <div className="decision-actions">
                <button className="mdbase-button" disabled={busy} onClick={() => void act("deny")}><Trans>Don't allow</Trans></button>
              </div>
            </>
          )}
      </RequestShell>
    );
  }
  return (
    <RequestShell busy={busy}>
        {installation ? (
          <>
            {outcome === "cancelled" ? (
              <>
                <h1><Trans>Sign-in cancelled</Trans></h1>
                <p className="mdbase-connect-lead">{pairing.return_url
                  ? <a href={pairing.return_url}><Trans>Return to {literal(pairing.connector_name)}</Trans></a>
                  : t(i18n)`Return to ${pairing.connector_name}.`}</p>
              </>
            ) : pairing.approved_at ? (
              <>
                <RequestOutcome status="approved" applicationName={pairing.connector_name} collectionName={selectedName}
                  collectionKind={privateChoice ? "private" : "cloud_copy"} returnUrl={handBack.current ? pairing.return_url ?? "" : ""} />
                {!handBack.current && pairing.return_url && <a className="mdbase-button outcome-return" href={pairing.return_url}><Trans>Return to {literal(pairing.connector_name)}</Trans></a>}
                {pairing.timer_declaration && <p role="status">{pairing.timer_consent
                  ? t(i18n)({ message: "You allowed reminders for the selected collections." })
                  : t(i18n)({ message: "Reminders are off. You can turn them on in the app by approving reminders again." })}</p>}
              </>
            ) : (
              <>
                <RequestIdentity request={{ application_name: pairing.connector_name, application_origin: pairing.app_origin,
                  platform: pairing.app_platform, homepage: pairing.app_origin ?? "", expires_at: pairing.expires_at }} showClientKey={false} />
                {installationAccountLabel(pairing) ? (
                  <p className="installation-account-label"><Trans>Account: {literal(installationAccountLabel(pairing))}</Trans></p>
                ) : (
                  <>
                    <p><Trans>We couldn't identify your account. Sign in again to continue.</Trans></p>
                    <a className="mdbase-button installation-account-action" href={`/login?return_to=${encodeURIComponent(location.href)}`}><Trans>Sign in again</Trans></a>
                  </>
                )}
                {pairing.account_selection_confirmed && !pairing.attested && <p role="status">{preparationError || t(i18n)`Preparing ${pairing.connector_name}…`}</p>}
                    <CollectionPicker
                      label={t(i18n)`Open in ${pairing.connector_name}`}
                      collections={(pairing.collections ?? []).map(collection=>({id:collection.collection_id,name:collection.display_name,kind:collection.kind ?? "cloud_copy",
                        location: collection.kind === "private" ? t(i18n)`Private collection — on your computers` : t(i18n)`Hosted by mdbase`,
                        hint:collection.role&&collection.role!=="owner"?t(i18n)`Shared with you`:undefined}))}
                      value={selectedCollectionId} onChoose={setSelectedCollectionId} disabled={busy}
                      onCreate={pairing.can_create_collection && !pairing.creation?.completed ? ()=>setSelectedCollectionId(NEW_COLLECTION) : undefined}
                      creationSelected={selectedCollectionId===NEW_COLLECTION}
                    />
                    {selectedCollectionId === NEW_COLLECTION && <div className="installation-choice">
                      <label htmlFor="installation-collection-name"><Trans>New collection name</Trans></label>
                      <input className="mdbase-field" id="installation-collection-name" aria-describedby="installation-collection-note" value={newCollectionName} maxLength={200} disabled={busy} readOnly={!!pairing.creation} onChange={event=>setNewCollectionName(event.target.value)} />
                      <small id="installation-collection-note"><Trans>Approve will create this collection and open it in {literal(pairing.connector_name)}.</Trans></small>
                      {pairing.creation && <small role="status"><Trans>Creation hasn't finished. Approve continues the same named collection.</Trans></small>}
                    </div>}
                    {privateChoice && <p className="field-note"><Trans>This collection stays on your computer. It can connect when a computer signed in to this account is available.</Trans></p>}
                    {privateChoice && !pairing.native_authorization_id && <p role="status">{preparationError || t(i18n)`Preparing ${pairing.connector_name}…`}</p>}
                    {!privateChoice && (pairing.collections?.some(c=>c.kind!=="private") || pairing.retained_collection_ids?.length || pairing.requested_create_collections || pairing.retained_create_collections) ? <details className="mdbase-disclosure installation-advanced">
                      <summary><Trans>Allow offline access to additional collections</Trans></summary>
                      <CheckboxGroup legend={t(i18n)({ message: "Additional collection access" })} disabled={busy}>
                        {(pairing.collections??[]).filter(c=>c.kind!=="private").map(collection=>(
                          <div className="collection-picker-option installation-additional-collection" key={collection.collection_id}>
                            <Checkbox checked={collection.collection_id===selectedCollectionId || collectionIds.includes(collection.collection_id)} disabled={collection.collection_id===selectedCollectionId || pairing.retained_collection_ids?.includes(collection.collection_id)} onChange={event=>setCollectionIds(ids=>event.target.checked?[...new Set([...ids,collection.collection_id])]:ids.filter(id=>id!==collection.collection_id))}>
                              <CollectionIdentity name={collection.display_name} location={collection.kind === "private" ? t(i18n)`Private collection — on your computers` : t(i18n)`Hosted by mdbase`} kind={collection.kind ?? "cloud_copy"} />{pairing.retained_collection_ids?.includes(collection.collection_id) ? t(i18n)` (already allowed)` : ""}
                            </Checkbox>
                            {pairing.scope_only && pairing.retained_collection_ids?.includes(collection.collection_id) && <button type="button" className="mdbase-button installation-account-action" onClick={()=>setRemovingId(collection.collection_id)}><Trans>Revoke access</Trans></button>}
                          </div>
                        ))}
                        {(pairing.retained_collection_ids??[]).filter(id=>!pairing.collections?.some(collection=>collection.collection_id===id)).map(id=><div key={id}><p><Trans>Already allowed collection (currently unavailable)</Trans></p><button type="button" className="mdbase-button installation-account-action" onClick={()=>setRemovingId(id)}><Trans>Revoke access</Trans></button></div>)}
                        {(pairing.requested_create_collections || pairing.retained_create_collections) && <Checkbox checked={createCollections} disabled={pairing.retained_create_collections} onChange={event=>setCreateCollections(event.target.checked)}>
                           <Trans>Allow {literal(pairing.connector_name)} to create new collections</Trans> </Checkbox>}
                      </CheckboxGroup>
                    </details> : null}
                    {!privateChoice && pairing.timer_declaration && <div className="installation-choice">
                      <Checkbox disabled={busy} checked={allowReminders} onChange={event=>setAllowReminders(event.target.checked)}>
                         <Trans>Allow {literal(pairing.connector_name)} to send you reminders</Trans> </Checkbox>
                      <p className="field-note"><Trans>Applies to the collection you chose to open and any new collections selected here. Other collections are not included.</Trans></p>
                      {!allowReminders && <p role="status"><Trans>Reminders will be off. You can finish setup and turn them on later in the app. Collection access stays unchanged.</Trans></p>}
                    </div>}
                    {removingId && <div role="group" aria-label={t(i18n)({ message: "Confirm revocation", context: "Collection connection" })}>
                      <p><Trans>{literal(pairing.connector_name)} will lose access to {literal(pairing.collections?.find(collection=>collection.collection_id===removingId)?.display_name??t(i18n)({ message: "this collection", context: "Collection connection" }))} on all its devices. Previously downloaded data cannot be erased.</Trans></p>
                      <button className="mdbase-button installation-account-action" disabled={busy} onClick={()=>setRemovingId("")}><Trans>Keep access</Trans></button>
                      <button className="mdbase-button is-primary installation-account-action" disabled={busy} onClick={()=>void act("remove-access")}><Trans>Revoke access</Trans></button>
                    </div>}
                    {revokingId && <p role="status"><Trans>Revoking access to {literal(pairing.collections?.find(collection=>collection.collection_id===revokingId)?.display_name??t(i18n)({ message: "this collection", context: "Collection connection" }))}…</Trans></p>}
                    {details}
                    <footer className="approval-footer">
                      <div className="approval-receipt approval-target" id={`pairing-target-${pairingId}`} ref={approvalTarget} tabIndex={-1}>
                        {selectedName && <div className="collection-identity-copy"><strong className="collection-name">{selectedName}</strong><small>{privateChoice ? t(i18n)`Private collection — on your computers` : t(i18n)`Hosted by mdbase`}</small></div>}
                        <p><Trans>This device can keep notes, files and account/member information offline. Downloaded copies cannot be erased.</Trans></p>
                        {createCollections && !privateChoice && <p><Trans>Allow {literal(pairing.connector_name)} to create new collections</Trans></p>}
                        {pairing.scope_only && <p><Trans>Already-allowed access stays in place. Revoke access separately if you no longer want it.</Trans></p>}
                        <p><Trans>Access continues until you revoke it in mdbase Connect.</Trans></p>
                      </div>
                      <div className="approval-actions">
                    <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => void act("deny")}><Trans>Cancel</Trans></button>
                    <button className="mdbase-button is-primary"
                      aria-describedby={`pairing-target-${pairingId}`}
                      disabled={busy || !installationAccountLabel(pairing) || !selectedCollectionId || (selectedCollectionId===NEW_COLLECTION ? !pairing.can_create_collection || !newCollectionName.trim() : !pairing.collections?.some(collection=>collection.collection_id===selectedCollectionId))}
                      onClick={()=>void act("approve")}>
                      {busy ? t(i18n)({ message: "Approving…", context: "Collection connection" }) : t(i18n)`Open ${pairing.connector_name}`}
                    </button>
                      </div>
                    </footer>
              </>
            )}
            {pairing.approved_at && details}
          </>
        ) : deepLink ? (
          <>
            <p className="eyebrow"><Trans>Computer approved</Trans></p>
            <h1><Trans>You can close this tab.</Trans></h1>
            <p><Trans>Signing in finishes on that computer.</Trans></p>
          </>
        ) : (
          <>
            <p className="eyebrow"><Trans>Sign in on a computer</Trans></p>
            <h1>{pairing.connector_name}</h1>
            <p><Trans>
              Allow mdbase on this computer to use your account. This is needed
              after installing or updating the desktop app, even on a computer
              you used before. It will publish collection names and route
              app requests, but not local folder paths.
            </Trans></p>
            <div className="decision-actions">
              <a className="mdbase-button" href="/"><Trans>
                Cancel
              </Trans></a>
              <button
                className="mdbase-button is-primary"
                disabled={busy}
                onClick={() => void act("approve")}
              ><Trans>
                Approve computer
              </Trans></button>
            </div>
          </>
        )}
        {error && (
          <div className="mdbase-message is-error" role="alert">
            {error}
            {retry && !busy && <button className="mdbase-button installation-account-action" onClick={() => void act(retry)}><Trans>Try again</Trans></button>}
          </div>
        )}
    </RequestShell>
  );
}

export function MirrorPairing({ pairingId }: { pairingId: string }) {
  useLocaleRevision();
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
    <main className="mdbase-page">
      <PageBrand label={t(i18n)({ message: "Folder sync", context: "Collection connection" })} busy={busy} error={error} />
      <section className="mdbase-page-panel">
        {approved ? (
          <>
            <p className="eyebrow outcome-label"><Trans>Folder approved</Trans></p>
            <h1><Trans>Return to your computer.</Trans></h1>
            <p><Trans>
              {literal(selected?.display_name ?? t(i18n)({ message: "The collection", context: "Collection connection" }))} will begin syncing
              automatically. You can close this page.
            </Trans></p>
          </>
        ) : (
          <>
            <p className="eyebrow"><Trans>New synced folder</Trans></p>
            <h1>{request.pairing.mirror_name}</h1>
            <p>
              {request.pairing.mode === "read_write"
                ? t(i18n)({ message: "Markdown edits will sync in both directions. Concurrent edits remain separate until you choose a version." })
                : t(i18n)({ message: "This folder will receive Markdown from mdbase and will not upload local edits." })}
            </p>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            {request.collections.length ? (
              <>
                <label>
                  <span><Trans>Hosted collection</Trans></span>
                  <Select
                    aria-label={t(i18n)({ message: "Hosted collection", context: "Collection connection" })}
                    value={collectionId}
                    options={request.collections.map((collection) => ({
                      value: collection.id,
                      label: collection.display_name,
                    }))}
                    onChange={setCollectionId}
                  />
                </label>
                <p className="field-note"><Trans>
                  Existing Markdown is checked before upload. Collection paths
                  and device credentials stay off the control plane.
                </Trans></p>
                <div className="decision-actions">
                  <a className="mdbase-button" href="/"><Trans>
                    Cancel
                  </Trans></a>
                  <button
                    className="mdbase-button is-primary"
                    disabled={busy || !collectionId}
                    onClick={() => void approve()}
                  >
                    {busy ? t(i18n)({ message: "Approving…", context: "Collection connection" }) : t(i18n)({ message: "Sync this collection", context: "Collection connection" })}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mdbase-message">
                   {t(i18n)({ message: "Create a hosted collection before approving this folder." })} </div>
                <div className="decision-actions">
                  <a className="mdbase-button is-primary" href="/"><Trans>
                    Open your collections
                  </Trans></a>
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
  useLocaleRevision();
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
    <main className="mdbase-page">
      <PageBrand label={t(i18n)({ message: "Move collection online", context: "Collection connection" })} busy={busy} error={error} />
      <section className="mdbase-page-panel authority-decision">
        {adoption.state === "completed" ? (
          <>
            <p className="eyebrow outcome-label"><Trans>Move complete</Trans></p>
            <h1><Trans>{literal(adoption.display_name)} is now hosted.</Trans></h1>
            <p><Trans>
              mdbase now keeps the main copy of this collection.
              {literal(adoption.retain_mirror
                ? t(i18n)` ${adoption.mirror_name ?? adoption.source_name} will continue as a synced folder, with edits syncing both ways.`
                : t(i18n)({ message: " The original local files are no longer the main copy." }))}
            </Trans></p>
            <div className="transfer-status" role="status">
              <StatusGlyph state="online" />
              <span><Trans>Main copy hosted by mdbase</Trans></span>
            </div>
            <a className="mdbase-button is-primary" href="/"><Trans>
              Return to your account
            </Trans></a>
          </>
        ) : inactive ? (
          <>
            <p className="eyebrow"><Trans>Move ended</Trans></p>
            <h1><Trans>Your local collection was kept.</Trans></h1>
            <p><Trans>The main copy was not moved to mdbase.</Trans></p>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            <a className="mdbase-button is-primary" href="/"><Trans>
              Return to your account
            </Trans></a>
          </>
        ) : adoption.state !== "requested" ? (
          <>
            <p className="eyebrow outcome-label"><Trans>Move approved</Trans></p>
            <h1><Trans>Return to {literal(adoption.source_name)}.</Trans></h1>
            <p><Trans>
              The app is uploading and checking a final collection snapshot. The
              main copy will move only after that exact snapshot is complete.
            </Trans></p>
            <div className="transfer-status" role="status">
              <StatusGlyph state="connecting" />
              <span>
                {adoption.state === "activating"
                  ? t(i18n)({ message: "Finishing the move", context: "Collection connection" })
                  : t(i18n)({ message: "Waiting for the app", context: "Collection connection" })}
              </span>
            </div>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
          </>
        ) : (
          <>
            <p className="eyebrow"><Trans>Move a local collection to mdbase</Trans></p>
            <h1>{adoption.display_name}</h1>
            <p><Trans>
              Approving uploads the complete collection from{" "}
              {literal(adoption.source_name)}, validates it as one snapshot, and then
              makes the hosted version the main copy.
            </Trans></p>
            <div className="mdbase-message">
              {adoption.retain_mirror
                ? t(i18n)`After the move, ${adoption.mirror_name ?? adoption.source_name} stays as a synced folder. It will not be a second main copy.`
                : t(i18n)({ message: "After the move, the original local files are no longer the main copy." })}
            </div>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <a className="mdbase-button" href="/"><Trans>
                Cancel
              </Trans></a>
              <button
                className="mdbase-button is-primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                {busy ? t(i18n)({ message: "Approving…", context: "Collection connection" }) : t(i18n)({ message: "Move this collection", context: "Collection connection" })}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export function AuthorityTransfer({ transferId }: { transferId: string }) {
  useLocaleRevision();
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
  const collectionName = transfer.collection_name ?? t(i18n)({ message: "This collection", context: "Collection connection" });
  const mirrorName = transfer.mirror_name ?? t(i18n)({ message: "the selected computer", context: "Collection connection" });
  const waiting =
    transfer.state === "approved" || transfer.state === "prepared";
  const inactive =
    transfer.state === "cancelled" || transfer.state === "expired";
  return (
    <main className="mdbase-page">
      <PageBrand label={t(i18n)({ message: "Move main copy", context: "Collection connection" })} busy={busy} error={error} />
      <section className="mdbase-page-panel authority-decision">
        {transfer.state === "completed" ? (
          <>
            <p className="eyebrow outcome-label"><Trans>Transfer complete</Trans></p>
            <h1>{t(i18n)`${collectionName} now lives on your computer.`}</h1>
            <p>{t(i18n)`The folder on ${mirrorName} is now the main copy. Hosted access has stopped and previous app connections were revoked.`}</p>
            <div className="transfer-status" role="status">
              <StatusGlyph state="online" />
              <span>{t(i18n)`Main copy on ${mirrorName}`}</span>
            </div>
            <a className="mdbase-button is-primary" href="/"><Trans>
              Return to your account
            </Trans></a>
          </>
        ) : inactive ? (
          <>
            <p className="eyebrow"><Trans>Transfer ended</Trans></p>
            <h1><Trans>The main copy stayed hosted.</Trans></h1>
            <p>{t(i18n)`${collectionName} remains hosted. Its main copy did not move.`}</p>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            <a className="mdbase-button is-primary" href="/"><Trans>
              Return to your account
            </Trans></a>
          </>
        ) : waiting ? (
          <>
            <p className="eyebrow outcome-label"><Trans>Transfer approved</Trans></p>
            <h1>{t(i18n)`Return to ${mirrorName}.`}</h1>
            <p><Trans>
              mdbase Connect is checking the latest hosted changes, registering
              the folder, and making it the main copy.
            </Trans></p>
            <div className="transfer-status" role="status">
              <StatusGlyph state="connecting" />
              <span>
                {transfer.state === "prepared"
                  ? t(i18n)({ message: "Hosted writes are paused", context: "Collection connection" })
                  : t(i18n)({ message: "Waiting for the computer", context: "Collection connection" })}
              </span>
            </div>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <button
                className="mdbase-button is-tertiary is-danger"
                disabled={busy}
                onClick={() => void cancel()}
              ><Trans>
                Cancel transfer
              </Trans></button>
            </div>
          </>
        ) : (
          <>
            <p className="eyebrow"><Trans>Move the main copy</Trans></p>
            <h1>{t(i18n)`Use the folder on ${mirrorName} as the main copy?`}</h1>
            <p>{t(i18n)`${collectionName} will stop being hosted and become a computer-owned collection. This changes where every future edit is accepted.`}</p>
            <dl className="transfer-consequences">
              <div>
                <dt><Trans>Folder</Trans></dt>
                <dd><Trans>The synced Markdown folder becomes the main copy.</Trans></dd>
              </div>
              <div>
                <dt><Trans>Hosted service</Trans></dt>
                <dd><Trans>
                  Writes pause during verification, then hosted access is
                  retired.
                </Trans></dd>
              </div>
              <div>
                <dt><Trans>Apps</Trans></dt>
                <dd><Trans>
                  Existing access is revoked. Connect apps again to use
                  the local collection.
                </Trans></dd>
              </div>
              <div>
                <dt><Trans>Recovery</Trans></dt>
                <dd><Trans>
                  If verification fails or this request expires, hosted writes
                  resume.
                </Trans></dd>
              </div>
            </dl>
            {error && (
              <div className="mdbase-message is-error" role="alert">
                {error}
              </div>
            )}
            <div className="decision-actions">
              <button
                className="mdbase-button"
                disabled={busy}
                onClick={() => void cancel()}
              ><Trans>
                Keep it hosted
              </Trans></button>
              <button
                className="mdbase-button is-primary"
                disabled={busy}
                onClick={() => void approve()}
              >
                {busy ? t(i18n)({ message: "Approving…", context: "Collection connection" }) : t(i18n)({ message: "Move main copy", context: "Collection connection" })}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
