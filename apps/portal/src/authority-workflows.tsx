import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useRef, useState } from "react";
import { literal } from "./literal";
import {
  api,
  ApiError,
  type DevicePairing,
} from "./api";
import { finishDeniedPairing, pendingPairingChoice, rememberCollection, installationAccountLabel, installationRefusal, message, NEW_COLLECTION, pairingInspectionPath } from "./portal-model";
import { CollectionPicker, CollectionIdentity, RequestShell, fileActionLabel, useRequestExpiry } from "./authorization-review";
import { RequestIdentity, RequestOutcome } from "./authorization-view";
import { watchPairingCollections, watchPairingPreparation } from "./pairing-progress";
import { Checkbox, CheckboxGroup } from "@mdbase-dev/ui/checkbox";
type PairingRequest = DevicePairing & { expires_at?: string };
type PairingCollection = NonNullable<DevicePairing["collections"]>[number];
/** Where a collection offered at sign-in lives, in the words shown beside its name. */
const collectionLocation = (kind: PairingCollection["kind"]) => kind === "private" ? t(i18n)`Private collection — on your computers`
  : kind === "private_device" ? t(i18n)`Private collection — key kept on this device`
  : t(i18n)({ message: "Cloud copy", context: "Collection storage mode" });
/** Scopes this installation already holds, of either kind. */
const retainedIds = (pairing: DevicePairing) => [...(pairing.retained_collection_ids ?? []), ...(pairing.retained_private_device_collection_ids ?? [])];

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
  // The request was started with another account than the one signed in here.
  const [otherAccount,setOtherAccount] = useState(false);
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
    setCollectionIds([...new Set([...retainedIds(value), ...(value.approved_collection_ids ?? []), ...(value.approved_private_device_collection_ids ?? [])])]);
    // A pick made on this page before the app sent the person away stays
    // chosen when the app opens the page again, while it is still offered.
    const kept = value.approved_at || !value.return_url ? null : pendingPairingChoice.read(pairingId);
    setSelectedCollectionId(value.creation && !value.creation.completed ? NEW_COLLECTION
      : value.selected_collection_id || value.creation?.collection_id
        || (kept && value.collections?.some(c => c.collection_id === kept) ? kept : ""));
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
    setOtherAccount(false);
    accountSelectionSucceeded.current = false;
    dispatching.current = false;
    api<{ pairing: DevicePairing }>(inspectionPath)
      .then(value => applyPairing(value.pairing, current))
      .catch((reason) => {
        if (current !== generation.current) return;
        if (reason instanceof ApiError && reason.status === 401)
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else if (reason instanceof ApiError && reason.code === "installation_account_changed") setOtherAccount(true);
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
      // An app with a way back is suspended while this page is in front: it is
      // not a failure that it hasn't prepared; the page offers the way back.
      onTimeout: () => setPreparationError(pairing.return_url ? "" : t(i18n)`We couldn't prepare ${pairing.connector_name}.`),
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
      onTimeout:()=>setPreparationError(pairing.return_url ? "" : t(i18n)`We couldn't prepare ${pairing.connector_name}. Make sure the app is up to date.`),
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
          if (pairing.return_url) {
            // The app prepares only once the person goes back to it (its way
            // back is offered on this page), so don't hold the page waiting.
            approval = (await api<{pairing:DevicePairing}>(inspectionPath)).pairing;
            if (current !== generation.current) return;
            setPairing(approval);
            if (approval.approved_at) return;
            if (!ready(approval)) return;
          } else approval = await new Promise<DevicePairing>((resolve, reject) => {
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
      // Device access is only ever sent for a collection shown with that label.
      const device = (id: string) => pairing.collections?.some(c=>c.collection_id===id && c.kind==="private_device")===true;
      const picked = privateChoice ? [] : [...new Set([...collectionIds, selected])].filter(id=>id && !retainedIds(approval).includes(id));
      const approvedIds = picked.filter(id=>!device(id)), deviceIds = picked.filter(device);
      if (action === "approve") approvalAttempted = true;
      const result = await api<{ deep_link?: string; native_authorization_uri?:string }>(
        `/v1/pairing-requests/${pairingId}/${action}`,
        { method: "POST", ...(action==="remove-access" ? {body:JSON.stringify({collection_id:removingId,confirm:true})} : action==="approve" && pairing.file_access ? {body:JSON.stringify({fingerprint:pairing.fingerprint,collection_ids:[],file_actions:pairing.file_access.actions})} : action==="approve" && pairing.installation_device ? {body:JSON.stringify({fingerprint:approval.fingerprint,collection_ids:approvedIds,create_collections:!privateChoice && createCollections && !approval.retained_create_collections,...(device(selected)?{}:{selected_collection_id:selected}),...(privateChoice?{selected_collection_kind:"private"}:approval.timer_declaration&&!device(selected)?{timer_consent:allowReminders}:{}),...(deviceIds.length?{private_device_collection_ids:deviceIds}:{})})} : {}) },
      );
      if (current !== generation.current) return;
      if (action === "deny" && pairing.file_access) {
        setDeclined(true);
        return;
      }
      if (action === "deny") {
        pendingPairingChoice.clear(pairingId);
        if (finishDeniedPairing(pairing, window) === "cancelled") setOutcome("cancelled");
        return;
      }
      if (action === "approve" && pairing.installation_device && !pairing.file_access) rememberCollection(selected);
      if (action === "approve") pendingPairingChoice.clear(pairingId);
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

  /** Cancel a request this account cannot see, so the app stops waiting on it.
   * The server allows it while no account has been selected in this window. */
  async function cancelOtherAccount() {
    if (dispatching.current) return;
    const current = generation.current;
    dispatching.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/pairing-requests/${pairingId}/deny`, { method: "POST" });
      if (current !== generation.current) return;
      if (finishDeniedPairing({ installation_device: true }, window) === "cancelled") setOutcome("cancelled");
    } catch (reason) {
      if (current === generation.current) setError(message(reason));
    } finally {
      if (current === generation.current) {
        dispatching.current = false;
        setBusy(false);
      }
    }
  }

  if (!pairing && otherAccount)
    return (
      <RequestShell busy={busy}>
        {outcome === "cancelled" ? (
          <>
            <h1><Trans>Sign-in cancelled</Trans></h1>
            <p className="mdbase-connect-lead"><Trans>Return to the app.</Trans></p>
          </>
        ) : (
          <>
            <h1><Trans>Signed in to a different account</Trans></h1>
            <p className="mdbase-connect-lead" role="alert"><Trans>This sign-in was started with a different mdbase account. To continue, switch back to that account, then check again. Or cancel the sign-in, and the app stops waiting.</Trans></p>
            {error && <p role="alert">{error}</p>}
            <footer className="approval-footer">
              <div className="approval-actions">
                <button className="mdbase-button is-secondary" disabled={busy} onClick={() => void cancelOtherAccount()}><Trans>Cancel sign-in</Trans></button>
                <button className="mdbase-button is-primary" disabled={busy} onClick={() => setAttempt(value => value + 1)}><Trans>Check again</Trans></button>
              </div>
            </footer>
          </>
        )}
      </RequestShell>
    );
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
  const privateChoice=selectedCollection?.kind==="private", deviceChoice=selectedCollection?.kind==="private_device";
  const retained=retainedIds(pairing);
  // One node for both mentions, so translators get a single named placeholder.
  const appName=literal(pairing.connector_name);
  // An app opened in the system browser (Android, iOS) is suspended while this
  // page is in front, so it cannot prepare. Send the person back to it; the app
  // prepares and shows this page again (tasknotes-app#492).
  const waitsForApp=!!pairing.return_url && !!pairing.account_selection_confirmed && (!pairing.attested || (privateChoice && !pairing.native_authorization_id));
  const preparing=(error:string)=>error || (pairing.return_url ? t(i18n)`Continue in ${pairing.connector_name} to finish. This page opens again when it's ready.` : t(i18n)`Preparing ${pairing.connector_name}…`);
  // Collections this approval would newly give this device the key to.
  const deviceAccess=!privateChoice && (pairing.collections??[]).some(c=>c.kind==="private_device" && !retained.includes(c.collection_id) && (c.collection_id===selectedCollectionId || collectionIds.includes(c.collection_id)));
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
                  homepage: pairing.app_origin ?? "", expires_at: pairing.expires_at }} showClientKey={false} />
                {installationAccountLabel(pairing) ? (
                  <p className="installation-account-label"><Trans>Account: {literal(installationAccountLabel(pairing))}</Trans></p>
                ) : (
                  <>
                    <p><Trans>We couldn't identify your account. Sign in again to continue.</Trans></p>
                    <a className="mdbase-button installation-account-action" href={`/login?return_to=${encodeURIComponent(location.href)}`}><Trans>Sign in again</Trans></a>
                  </>
                )}
                {pairing.account_selection_confirmed && !pairing.attested && <p role="status">{preparing(preparationError)}</p>}
                    <CollectionPicker
                      label={t(i18n)`Open in ${pairing.connector_name}`}
                      collections={(pairing.collections ?? []).map(collection=>({id:collection.collection_id,name:collection.display_name,kind:collection.kind ? "private" as const : "cloud_copy" as const,
                        location: collectionLocation(collection.kind),
                        hint:collection.role&&collection.role!=="owner"?t(i18n)`Shared with you`:undefined}))}
                      value={selectedCollectionId} onChoose={id=>{setSelectedCollectionId(id);if(pairing.return_url)pendingPairingChoice.write(pairingId,id);}} disabled={busy}
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
                    {privateChoice && !pairing.native_authorization_id && (pairing.account_selection_confirmed || !pairing.return_url) && <p role="status">{preparing(preparationError)}</p>}
                    {!privateChoice && (pairing.collections?.some(c=>c.kind!=="private") || retained.length || pairing.requested_create_collections || pairing.retained_create_collections) ? <details className="mdbase-disclosure installation-advanced">
                      <summary><Trans>Allow offline access to additional collections</Trans></summary>
                      <CheckboxGroup legend={t(i18n)({ message: "Additional collection access" })} disabled={busy}>
                        {(pairing.collections??[]).filter(c=>c.kind!=="private").map(collection=>(
                          <div className="collection-picker-option installation-additional-collection" key={collection.collection_id}>
                            <Checkbox checked={collection.collection_id===selectedCollectionId || collectionIds.includes(collection.collection_id)} disabled={collection.collection_id===selectedCollectionId || retained.includes(collection.collection_id)} onChange={event=>setCollectionIds(ids=>event.target.checked?[...new Set([...ids,collection.collection_id])]:ids.filter(id=>id!==collection.collection_id))}>
                              <CollectionIdentity name={collection.display_name} location={collectionLocation(collection.kind)} kind={collection.kind ? "private" : "cloud_copy"} />{retained.includes(collection.collection_id) ? t(i18n)` (already allowed)` : ""}
                            </Checkbox>
                            {pairing.scope_only && retained.includes(collection.collection_id) && <button type="button" className="mdbase-button installation-account-action" onClick={()=>setRemovingId(collection.collection_id)}><Trans>Revoke access</Trans></button>}
                          </div>
                        ))}
                        {retained.filter(id=>!pairing.collections?.some(collection=>collection.collection_id===id)).map(id=><div key={id}><p><Trans>Already allowed collection (currently unavailable)</Trans></p><button type="button" className="mdbase-button installation-account-action" onClick={()=>setRemovingId(id)}><Trans>Revoke access</Trans></button></div>)}
                        {(pairing.requested_create_collections || pairing.retained_create_collections) && <Checkbox checked={createCollections} disabled={pairing.retained_create_collections} onChange={event=>setCreateCollections(event.target.checked)}>
                           <Trans>Allow {literal(pairing.connector_name)} to create new collections</Trans> </Checkbox>}
                      </CheckboxGroup>
                    </details> : null}
                    {!privateChoice && !deviceChoice && pairing.timer_declaration && <div className="installation-choice">
                      <Checkbox disabled={busy} checked={allowReminders} onChange={event=>setAllowReminders(event.target.checked)}>
                         <Trans>Allow {literal(pairing.connector_name)} to send you reminders</Trans> </Checkbox>
                      <p className="field-note"><Trans>Applies to the collection you chose to open and any new collections selected here. Other collections are not included.</Trans></p>
                      {!allowReminders && <p role="status"><Trans>Reminders will be off. You can finish setup and turn them on later in the app. Collection access stays unchanged.</Trans></p>}
                    </div>}
                    {removingId && <div role="group" aria-label={t(i18n)({ message: "Confirm revocation", context: "Collection connection" })}>
                      <p><Trans>{literal(pairing.connector_name)} will lose access to {literal(pairing.collections?.find(collection=>collection.collection_id===removingId)?.display_name??t(i18n)({ message: "this collection", context: "Collection connection" }))} on all its devices. Previously downloaded data cannot be erased.</Trans></p>
                      {pairing.retained_private_device_collection_ids?.includes(removingId) && <p><Trans>If you unlocked this collection in {literal(pairing.connector_name)}, it has had your account's encryption key, and revoking access doesn't take that key back. If you no longer trust it with your encryption password, change your encryption password.</Trans></p>}
                      <button className="mdbase-button installation-account-action" disabled={busy} onClick={()=>setRemovingId("")}><Trans>Keep access</Trans></button>
                      <button className="mdbase-button is-primary installation-account-action" disabled={busy} onClick={()=>void act("remove-access")}><Trans>Revoke access</Trans></button>
                    </div>}
                    {revokingId && <p role="status"><Trans>Revoking access to {literal(pairing.collections?.find(collection=>collection.collection_id===revokingId)?.display_name??t(i18n)({ message: "this collection", context: "Collection connection" }))}…</Trans></p>}
                    {details}
                    <footer className="approval-footer">
                      <div className="approval-receipt approval-target" id={`pairing-target-${pairingId}`} ref={approvalTarget} tabIndex={-1}>
                        {selectedName && <div className="collection-identity-copy"><strong className="collection-name">{selectedName}</strong><small>{collectionLocation(selectedCollectionId===NEW_COLLECTION ? undefined : selectedCollection?.kind)}</small></div>}
                        {deviceAccess && <p><Trans>{appName} on this device will hold the key to the private collections you allow here and will be able to read them. It will ask for your encryption password. Only allow this if you trust {appName} with that password.</Trans></p>}
                        <p><Trans>This device can keep notes, files and account/member information offline. Downloaded copies cannot be erased.</Trans></p>
                        {createCollections && !privateChoice && <p><Trans>Allow {literal(pairing.connector_name)} to create new collections</Trans></p>}
                        {pairing.scope_only && <p><Trans>Already-allowed access stays in place. Revoke access separately if you no longer want it.</Trans></p>}
                        <p><Trans>Access continues until you revoke it in mdbase Connect.</Trans></p>
                      </div>
                      <div className="approval-actions">
                    <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => void act("deny")}><Trans>Cancel</Trans></button>
                    {waitsForApp ? <a className="mdbase-button is-primary" href={pairing.return_url!}><Trans>Continue in {appName}</Trans></a> :
                    <button className="mdbase-button is-primary"
                      aria-describedby={`pairing-target-${pairingId}`}
                      disabled={busy || !installationAccountLabel(pairing) || !selectedCollectionId || (selectedCollectionId===NEW_COLLECTION ? !pairing.can_create_collection || !newCollectionName.trim() : !pairing.collections?.some(collection=>collection.collection_id===selectedCollectionId))}
                      onClick={()=>void act("approve")}>
                      {busy ? t(i18n)({ message: "Approving…", context: "Collection connection" }) : t(i18n)`Open ${pairing.connector_name}`}
                    </button>}
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
