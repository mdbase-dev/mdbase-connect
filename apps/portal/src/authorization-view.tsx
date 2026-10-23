import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { provisionedContract, type SetupType } from "@mdbase/connect-ui/contract-setup";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { APPLICATION_SETUP_OPERATIONS } from "@mdbase-dev/connect-protocol";
import {
  api,
  ApiError,
  type ApplicationFileAction,
  type AvailableCollection,
  type ContractSetupChoice as ContractSetupRequestChoice,
  type HostedCollection,
  type PendingAuthorization,
  type UnavailableConnector
} from "./api";
import { collectionCompatibility, lostCollectionNotice } from "./compatibility";
import {
  authorizationCapabilityGroups,
  authorizationRequirementsError,
  nextAuthorizationGroups,
  selectedNextAuthorizationOperations,
  toggleAuthorizationGroup,
  selectedFileActions,
  selectedPeoplePermissions,
  selectedOperationsForCapabilityGroups,
  type AuthorizationCapabilityGroup
} from "./authorization-capabilities";
import { configurationSetupSummary, initialContractSetupChoice } from "./application-setup";
import {
  clearAuthorizationReview,
  disambiguatedCollectionLocations,
  initialAuthorizationSelection,
  saveAuthorizationReview,
  storedAuthorizationReview
} from "./authorization-review-state";
import {
  ContractSetupEditor,
  contractSetupProblem,
  NotificationAccess,
  PermissionList,
  RequestedAccessSummary,
  type ContractSetupChoice
} from "./authorization-review";
import {
  formatDeviceCode,
  host,
  initials,
  message,
  neededProvisions,
  provisionNames,
  relativeTime
} from "./portal-model";
import { Loading, PageBrand } from "./portal-ui";
export function DeviceAuthorization() {
  useLocaleRevision();
  const initialCode = formatDeviceCode(new URLSearchParams(location.search).get("user_code") ?? "");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const automaticallyClaimed = useRef(false);

  async function openRequest(value: string) {
    const userCode = formatDeviceCode(value);
    if (userCode.replace("-", "").length !== 8) {
      setError(t(i18n)({ message: "Enter the eight-character code shown by the application." }));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ request_id: string }>(
        "/v1/device-authorization-requests/lookup",
        { method: "POST", body: JSON.stringify({ user_code: userCode }) }
      );
      location.replace(`/authorize/${result.request_id}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        return;
      }
      setError(message(reason));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!initialCode || automaticallyClaimed.current) return;
    automaticallyClaimed.current = true;
    void openRequest(initialCode);
  }, [initialCode]);

  return (
    <main className="center-page">
      <PageBrand label={t(i18n)({ message: "Application connection", context: "Application access approval" })} busy={busy} error={error} />
      <form className="decision-panel device-panel" onSubmit={(event) => {
        event.preventDefault();
        void openRequest(code);
      }}>
        <p className="eyebrow"><Trans>Short approval code</Trans></p>
        <h1><Trans>Check the application.</Trans></h1>
        <p><Trans>Enter the code it shows. You will review the application, collection, and exact permissions before anything is allowed.</Trans></p>
        <label className="device-code-field">
          <span><Trans>Approval code</Trans></span>
          <input
            autoFocus={!initialCode}
            autoComplete="one-time-code"
            inputMode="text"
            maxLength={9}
            value={code}
            onChange={(event) => setCode(formatDeviceCode(event.target.value))}
            placeholder="ABCD-EFGH"
          />
        </label>
        <p className="field-note"><Trans>Codes are not case-sensitive, expire after ten minutes, and can authorize only the key created by that application.</Trans></p>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="button primary" disabled={busy || code.replace("-", "").length !== 8}>
          {busy ? t(i18n)({ message: "Checking…", context: "Application access approval" }) : t(i18n)({ message: "Review request", context: "Application access approval" })}
        </button>
      </form>
    </main>
  );
}

type RequestStatus = "pending" | "setting_up" | "approved" | "denied" | "expired";

export function Authorization({ requestId }: { requestId: string }) {
  useLocaleRevision();
  const [request, setRequest] = useState<{
    authorization: PendingAuthorization;
    collections: AvailableCollection[];
    hosted_collections_available?: boolean;
    unavailable_connectors: UnavailableConnector[];
  } | null>(null);
  const [status, setStatus] = useState<RequestStatus>("pending");
  const [returnUrl, setReturnUrl] = useState("");
  const [structuralSetupRequested, setStructuralSetupRequested] = useState(false);
  const [continuingInDesktop, setContinuingInDesktop] = useState(
    () => new URLSearchParams(location.search).get("continue_in_desktop") === "1"
  );
  const [error, setError] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const returning = useRef(false);
  const loaded = useRef(false);

  useEffect(() => {
    let active = true;
    async function refreshCollections() {
      try {
        const next = await api<{
          authorization: PendingAuthorization;
          collections: AvailableCollection[];
          hosted_collections_available?: boolean;
          unavailable_connectors: UnavailableConnector[];
        }>(`/v1/authorization-requests/${requestId}`);
        if (active) {
          loaded.current = true;
          setRequest(next);
          setError("");
        }
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) {
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        } else if (reason instanceof ApiError && reason.status === 404) {
          // The request is no longer pending. Once loaded, the status poll owns
          // the outcome; before that, nothing on this page can be decided.
          if (!loaded.current) setStatus("expired");
        } else {
          setError(message(reason));
        }
      }
    }
    void refreshCollections();
    const timer = window.setInterval(() => void refreshCollections(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [requestId]);

  useEffect(() => {
    async function checkStatus() {
      try {
        const value = await api<{
          status: "pending" | "setting_up" | "approved" | "denied";
          redirect_uri?: string;
        }>(`/v1/authorization-requests/${requestId}/status`);
        if (returning.current) return;
        if (decisionError && value.status === "setting_up") return;
        setStatus(value.status);
        if (value.redirect_uri) {
          returning.current = true;
          setReturnUrl(value.redirect_uri);
          location.replace(value.redirect_uri);
        }
      } catch (reason) {
        // The status route answers 404 only for an expired or unknown request.
        // Other polling failures are transient and keep the pending decision.
        if (reason instanceof ApiError && reason.status === 404 && !returning.current) setStatus("expired");
      }
    }
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [decisionError, requestId]);

  if (!request) {
    if (status !== "expired") return <Loading error={error} />;
    return (
      <main className="center-page approval-page">
        <PageBrand label={t(i18n)({ message: "Application request", context: "Application access approval" })} />
        <section className="decision-panel authorization-panel">
          <RequestOutcome status="expired" applicationName={t(i18n)({ message: "the application", context: "Application access approval" })} standalone />
        </section>
      </main>
    );
  }
  const authorization = request.authorization;
  const preparingStructure = structuralSetupRequested || authorizationNeedsSetup(
    authorization,
    request.collections
  );
  const setupMotionActive = status === "setting_up"
    || (status === "pending" && structuralSetupRequested);
  function continueInDesktop(value: boolean) {
    const url = new URL(location.href);
    if (value) url.searchParams.set("continue_in_desktop", "1");
    else url.searchParams.delete("continue_in_desktop");
    history.replaceState(history.state, "", url);
    setContinuingInDesktop(value);
  }
  return (
    <main className="center-page approval-page">
      <PageBrand
        label={t(i18n)({ message: "Application request", context: "Application access approval" })}
        markMotion={setupMotionActive ? (preparingStructure ? "sort" : "stream") : undefined}
        error={error}
      />
      <section className="decision-panel authorization-panel">
        <RequestIdentity request={authorization} showClientKey={!request.collections.some((collection) => collection.kind === "private")} />
        {status === "pending" && continuingInDesktop ? (
          <DesktopContinuation
            request={authorization}
            onReviewHere={() => continueInDesktop(false)}
          />
        ) : status === "pending" ? <>
          {(decisionError || error) && <div className="message error" role="alert">{decisionError || error}</div>}
          <ApprovalForm
            request={authorization}
            canCreateHosted={request.hosted_collections_available !== false}
            collections={request.collections}
            unavailableConnectors={request.unavailable_connectors}
            onContinueInDesktop={() => continueInDesktop(true)}
            onDecision={(decision) => setStatus(decision)}
            onDecisionError={(detail) => { setDecisionError(detail); setStatus("pending"); }}
            onSetupActivityChange={setStructuralSetupRequested}
            onCollectionCreated={(collection) => setRequest((current) => current ? {
              ...current,
              collections: current.collections.some((existing) => existing.id === collection.id)
                ? current.collections
                : [...current.collections, collection]
            } : current)}
          />
        </> : <RequestOutcome
          status={status}
          applicationName={authorization.application_name}
          portable={authorization.distribution === "portable"}
          returnUrl={returnUrl}
        />}
      </section>
    </main>
  );
}

const RETURN_LINK_DELAY_MS = 4_000;
const SLOW_SETUP_MS = 20_000;

export function RequestOutcome({ status, applicationName, portable = false, returnUrl = "", standalone = false }: {
  status: Exclude<RequestStatus, "pending">;
  applicationName: string;
  portable?: boolean;
  returnUrl?: string;
  // Without a loaded request there is no application heading above the outcome.
  standalone?: boolean;
}) {
  useLocaleRevision();
  const Heading = standalone ? "h1" : "h2";
  // Show a manual return link or a slow-setup note only if the automatic step
  // has not already taken the user away.
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    const delay = status === "setting_up" ? SLOW_SETUP_MS : RETURN_LINK_DELAY_MS;
    const timer = window.setTimeout(() => setLate(true), delay);
    return () => window.clearTimeout(timer);
  }, [status]);
  const returnLink = late && returnUrl
    ? <a className="button secondary link-button outcome-return" href={returnUrl}><Trans>Return to {applicationName}</Trans></a>
    : null;
  if (status === "expired") return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label"><Trans>Request unavailable</Trans></p>
    <Heading>{t(i18n)({ message: "This request has expired or was already answered." })}</Heading>
    <p><Trans>Return to {applicationName} and connect again to start a new request.</Trans></p>
  </div>;
  if (status === "setting_up") return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label"><Trans>Approval recorded</Trans></p>
    <h2><Trans>Finishing collection setup…</Trans></h2>
    <p><Trans>Your choices are being checked with the collection’s main copy. The application does not have access yet.</Trans></p>
    {late && <p><Trans>This is taking longer than usual. Keep this page open; it continues automatically when setup finishes.</Trans></p>}
  </div>;
  const approved = status === "approved";
  return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label">{approved ? t(i18n)({ message: "Access approved", context: "Application access approval" }) : t(i18n)({ message: "Access denied", context: "Application access approval" })}</p>
    <h2>{portable ? t(i18n)`Return to ${applicationName}.` : t(i18n)`Returning to ${applicationName}…`}</h2>
    <p>{portable
      ? approved
        ? t(i18n)({ message: "The application will finish connecting with its one-time device code. You can close this window." })
        : t(i18n)({ message: "The application will learn that access was not granted. You can close this window." })
      : approved
        ? t(i18n)({ message: "Your approved collection and permissions will follow you back." })
        : t(i18n)({ message: "The application will show that access was not granted." })}</p>
    {returnLink}
  </div>;
}

export function RequestIdentity({ request, showClientKey = true }: { request: PendingAuthorization; showClientKey?: boolean }) {
  useLocaleRevision();
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  const portable = request.distribution === "portable";
  return (
    <header className="request-identity">
      <span className="request-identity-mark" aria-hidden="true">{request.icon && request.icon !== failedIcon
        ? <img src={request.icon} alt="" referrerPolicy="no-referrer" onError={() => setFailedIcon(request.icon)} />
        : initials(request.application_name)}</span>
      <div>
        <h1>{request.application_name}</h1>
        <p className="request-origin">{portable
          ? <>{t(i18n)({ message: "Application using a device code" })}{request.project_url && <> · <code>{host(request.project_url)}</code></>}</>
          : <code>{host(request.homepage)}</code>}</p>
        {portable
          ? <p className="request-guidance portable-authorization-warning" role="note"><Trans><strong>Application origin unverified.</strong> Continue only if you started this connection intentionally{request.user_code ? <Trans> and it shows <code>{request.user_code}</code></Trans> : null}.{request.project_url ? <Trans> {host(request.project_url)} does not verify its origin.</Trans> : null}</Trans></p>
          : <p className="request-guidance"><Trans>Only continue if you recognize this exact site.</Trans></p>}
        {showClientKey && request.client_fingerprint
          ? <p className="request-fingerprint"><Trans>App key <code>{request.client_fingerprint}</code>. Your computer will show this key when you approve the app.</Trans></p>
          : null}
        <p className="request-expiry"><Trans>Request expires {relativeTime(request.expires_at)}</Trans></p>
      </div>
    </header>
  );
}

function DesktopContinuation({ request, onReviewHere }: {
  request: PendingAuthorization;
  onReviewHere(): void;
}) {
  useLocaleRevision();
  const desktopUrl = `mdbase-connect://authorize?request_id=${encodeURIComponent(request.id)}`;
  return (
    <section className="desktop-continuation" aria-live="polite">
      <h2><Trans>Choose the folder in mdbase connect.</Trans></h2>
      <p><Trans>This request remains open while you connect the computer or add a collection. Approve it in the desktop app, then return here to continue to {request.application_name}.</Trans></p>
      <div className="desktop-continuation-status">
        <span className="status-dot connecting" aria-hidden="true" />
        <div><strong><Trans>Waiting for mdbase connect</Trans></strong><small><Trans>The page will notice when the request is approved.</Trans></small></div>
      </div>
      <div className="approval-actions">
        <button className="button secondary" type="button" onClick={onReviewHere}><Trans>Review in this browser</Trans></button>
        <a className="button primary link-button" href={desktopUrl}><Trans>Open mdbase connect</Trans></a>
      </div>
      <p className="field-note"><Trans>If the desktop app does not open, <a href="https://mdbase.dev/downloads/" target="_blank" rel="noreferrer">install the current Connect release</a>, then return to this page. The request expires {relativeTime(request.expires_at)}.</Trans></p>
    </section>
  );
}

export function ApprovalForm(props: React.ComponentProps<typeof SupportedApprovalForm>) {
  useLocaleRevision();
  const error = authorizationRequirementsError(props.request.requirements)
    ?? (props.request.account_backend === "next" ? nextAuthorizationGroups(props.request.requirements, props.request.requested_operations).error : undefined);
  if (error) return <div className="message error" role="alert">{error}</div>;
  return <SupportedApprovalForm {...props} />;
}

function SupportedApprovalForm({
  request,
  collections,
  canCreateHosted,
  unavailableConnectors = [],
  onContinueInDesktop,
  onDecision,
  onDecisionError,
  onSetupActivityChange,
  onCollectionCreated
}: {
  request: PendingAuthorization;
  collections: AvailableCollection[];
  canCreateHosted: boolean;
  unavailableConnectors?: UnavailableConnector[];
  onContinueInDesktop?(): void;
  onDecision(decision: "approved" | "denied"): void | Promise<void>;
  onDecisionError(detail: string): void;
  onSetupActivityChange?(active: boolean): void;
  onCollectionCreated(collection: AvailableCollection): void;
}) {
  const localeRevision = useLocaleRevision();
  const [createdCollections, setCreatedCollections] = useState<AvailableCollection[]>([]);
  const choices = useMemo(() => {
    const combined = new Map(collections.map((collection) => [collection.id, collection]));
    for (const collection of createdCollections) {
      if (!combined.has(collection.id)) combined.set(collection.id, collection);
    }
    return [...combined.values()].map((collection) => ({
      collection,
      compatibility: collectionCompatibility(request, collection)
    }));
  }, [collections, createdCollections, request, localeRevision]);
  const visibleChoices = useMemo(
    () => request.collection_id
      ? choices.filter((choice) => choice.collection.id === request.collection_id)
      : choices,
    [choices, request.collection_id]
  );
  const compatible = useMemo(
    () => visibleChoices.filter((choice) => choice.compatibility.compatible),
    [visibleChoices]
  );
  const collectionLocations = useMemo(
    () => disambiguatedCollectionLocations(
      compatible.map((choice) => choice.collection)
    ),
    [compatible]
  );
  const unavailable = useMemo(
    () => visibleChoices.filter((choice) => !choice.compatibility.compatible),
    [visibleChoices]
  );
  const savedReview = useMemo(() => storedAuthorizationReview(request.id), [request.id]);
  const jointPermissions = request.account_backend === "next";
  const requestedPermissionGroups = useMemo(
    () => jointPermissions
      ? nextAuthorizationGroups(request.requirements, request.requested_operations).groups
      : authorizationCapabilityGroups(request.requirements, request.requested_operations),
    [jointPermissions, request.requirements, request.requested_operations, localeRevision]
  );
  const initialSelection = initialAuthorizationSelection(
    compatible.map((choice) => choice.collection.id),
    savedReview
  );
  const [collectionId, setCollectionId] = useState(initialSelection.collectionId);
  const [collectionConfirmed, setCollectionConfirmed] = useState(
    Boolean(initialSelection.collectionId)
  );
  const [reviewing, setReviewing] = useState(initialSelection.reviewing);
  const [chosenOperations, setOperations] = useState(() => {
    const selected = jointPermissions
      ? selectedNextAuthorizationOperations(requestedPermissionGroups, savedReview?.operations, savedReview?.fileActions)
      : selectedOperationsForCapabilityGroups(requestedPermissionGroups, savedReview?.operations);
    const grouped = new Set(requestedPermissionGroups.flatMap((group) => group.operations));
    for (const operation of request.requested_operations) {
      if (!grouped.has(operation) && (!savedReview?.operations
        || request.requirements.capabilities?.contract_version === 2
        || savedReview.operations.includes(operation))) selected.add(operation);
    }
    return selected;
  });
  const people = "people" in request.requirements ? request.requirements.people : undefined;
  const [peoplePermissions, setPeoplePermissions] = useState(() =>
    people ? selectedPeoplePermissions(people, savedReview?.peoplePermissions) : new Set<string>());
  const [chosenFileActions, setFileActions] = useState(() => request.requirements.files
    ? selectedFileActions(request.requirements.files, savedReview?.fileActions)
    : new Set<string>()
  );
  const [submitting, setSubmitting] = useState<"approved" | "denied" | "creating" | null>(null);
  const [creatingHosted, setCreatingHosted] = useState(false);
  const [showAlternateCollections, setShowAlternateCollections] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [error, setError] = useState("");
  const [lostCollection, setLostCollection] = useState("");
  const collectionChoicesRef = useRef<HTMLFieldSetElement>(null);
  const createHostedTriggerRef = useRef<HTMLButtonElement>(null);
  const focusCollectionOnReturn = useRef(false);
  const focusHostedTriggerOnCancel = useRef(false);
  const lastSelected = useRef<AvailableCollection | undefined>(undefined);
  const selected = compatible.find((choice) => choice.collection.id === collectionId)?.collection;
  const selectedName = selected?.display_name ?? t(i18n)`this collection`;
  const approval = selected?.authorization;
  const allowedOperations = approval?.available ? approval.operations : undefined;
  const allowedFiles = approval?.available ? approval.file_actions : undefined;
  const permissionGroups = useMemo(() => requestedPermissionGroups.filter((group) =>
    (!allowedOperations || group.operations.every((operation) => allowedOperations.includes(operation)))
      && (!jointPermissions || !allowedFiles || (group.fileActions ?? []).every(action => allowedFiles.includes(action)))
  ), [allowedOperations, allowedFiles, jointPermissions, requestedPermissionGroups]);
  const operations = useMemo(() => {
    if (!jointPermissions) return new Set([...chosenOperations].filter(operation => !allowedOperations || allowedOperations.includes(operation)));
    const enabled = permissionGroups.filter(group => group.operations.every(operation => chosenOperations.has(operation)));
    const selected = new Set(enabled.flatMap(group => group.operations));
    if (enabled.some(group => group.id === "definitions.manage")) {
      for (const operation of APPLICATION_SETUP_OPERATIONS) {
        if (request.requested_operations.includes(operation) && (!allowedOperations || allowedOperations.includes(operation))) selected.add(operation);
      }
    }
    return selected;
  }, [allowedOperations, chosenOperations, jointPermissions, permissionGroups, request.requested_operations]);
  const fileActions = useMemo(() => jointPermissions
    ? new Set(permissionGroups.filter(group => group.operations.every(operation => operations.has(operation))).flatMap(group => group.fileActions ?? []))
    : new Set([...chosenFileActions].filter(action => !allowedFiles || allowedFiles.includes(action as ApplicationFileAction))),
  [allowedFiles, chosenFileActions, jointPermissions, operations, permissionGroups]);
  const existingOperations = useMemo(() => new Set(request.existing_access?.find((access) =>
    access.collection_id === collectionId)?.operations ?? []), [collectionId, request.existing_access]);
  // A Private collection is end-to-end encrypted: the application sets up its
  // types itself once connected, and a device of the account approves access.
  const privateCollection = selected?.kind === "private";
  const setup = selected && !privateCollection ? neededProvisions(request, selected) : [];
  const configurationSetup = privateCollection ? [] : request.provisions.configuration ?? [];
  const hasSetup = setup.length > 0 || configurationSetup.length > 0;
  const requestSetupSummary = [
    ...(request.provisions.type_packs.length > 0
      ? [t(i18n)`Adds ${provisionNames(request.provisions.type_packs)} to the collection`]
      : []),
    ...(configurationSetup.length > 0 ? [t(i18n)({ message: "Changes collection settings" })] : [])
  ];
  const setupContracts = useMemo(() => selected
    ? request.requirements.contracts.flatMap((required) => {
        if (selected.contracts.some((contract) =>
          contract.id === required.id
            && contract.version === required.version
            && contract.digest === required.digest)) return [];
        const contract = provisionedContract(required, request.provisions.type_packs);
        return contract ? [contract] : [];
      })
    : [], [request.provisions.type_packs, request.requirements.contracts, selected]);
  const setupTypes = useMemo<SetupType[]>(
    () => selected?.types ?? [],
    [selected]
  );
  const setupIdentity = [
    collectionId,
    ...setupContracts.map((contract) => `${contract.id}@${contract.version}`),
    ...setupTypes.map((type) => `${type.name}@${type.revision ?? ""}`)
  ].join("|");
  const [setupChoices, setSetupChoices] = useState<Record<string, ContractSetupChoice>>({});
  const selectedPermissionGroups = permissionGroups.filter((group) =>
    group.operations.every((operation) => operations.has(operation))
  );
  const selectedPermissionCount = selectedPermissionGroups.length
    + (!jointPermissions && fileActions.size > 0 ? 1 : 0);
  const higherImpactLabels = [
    ...selectedPermissionGroups.flatMap((group) =>
      group.higherImpact ? [group.label.toLocaleLowerCase()] : []
    ),
    ...(!jointPermissions && fileActions.has("delete") ? [t(i18n)({ message: "delete files", context: "Application access approval" })] : []),
    ...(peoplePermissions.has("members") ? [t(i18n)({ message: "see collection members", context: "Application access approval" })] : []),
    ...(hasSetup ? [t(i18n)({ message: "changes to collection setup" })] : [])
  ];
  const approvalBlocker = jointPermissions && requestedPermissionGroups.some(group => group.required && !permissionGroups.includes(group))
    ? t(i18n)({ message: "The collection cannot allow all required record and file permissions together. Choose another collection." })
    : selectedPermissionCount === 0 && (jointPermissions || !request.requirements.files)
    ? t(i18n)({ message: "Allow at least one permission to continue." })
    : setupContracts.map((contract) => contractSetupProblem(
        contract,
        setupChoices[`${contract.id}@${contract.version}`],
        setupTypes
      )).find(Boolean);
  const blockerId = `approval-blocker-${request.id}`;

  useEffect(() => {
    if (selected) lastSelected.current = selected;
  }, [selected]);

  useEffect(() => {
    if (collectionId && !compatible.some((choice) => choice.collection.id === collectionId)) {
      if (lastSelected.current?.id === collectionId) {
        setLostCollection(lostCollectionNotice(lastSelected.current, unavailable, unavailableConnectors));
      }
      setCollectionId("");
      setCollectionConfirmed(false);
      setReviewing(false);
    }
  }, [collectionId, compatible, unavailable, unavailableConnectors]);

  useEffect(() => {
    saveAuthorizationReview(request.id, {
      collectionId,
      collectionConfirmed,
      operations: [...operations],
      fileActions: [...fileActions],
      peoplePermissions: [...peoplePermissions],
      reviewing
    });
  }, [collectionConfirmed, collectionId, fileActions, operations, peoplePermissions, request.id, reviewing]);

  useEffect(() => {
    if (!reviewing && focusCollectionOnReturn.current) {
      focusCollectionOnReturn.current = false;
      collectionChoicesRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    }
  }, [reviewing]);

  useEffect(() => {
    if (!creatingHosted && focusHostedTriggerOnCancel.current) {
      focusHostedTriggerOnCancel.current = false;
      createHostedTriggerRef.current?.focus();
    }
  }, [creatingHosted]);

  useEffect(() => {
    setSetupChoices(Object.fromEntries(setupContracts.map((contract) => [
      `${contract.id}@${contract.version}`,
      initialContractSetupChoice(contract, setupTypes)
    ])));
  }, [setupIdentity]);

  const contractSetups = setupContracts.flatMap<ContractSetupRequestChoice>((contract) => {
    const choice = setupChoices[`${contract.id}@${contract.version}`];
    if (!choice) return [];
    if (choice.mode === "starter") return [{
      contract: { id: contract.id, version: contract.version, digest: contract.digest },
      mode: "starter" as const
    }];
    const type = setupTypes.find((candidate) => candidate.name === choice.typeName);
    if (!type?.revision) return [];
    return [{
      contract: { id: contract.id, version: contract.version, digest: contract.digest },
      mode: "existing" as const,
      type_name: type.name,
      type_revision: type.revision,
      fields: choice.fields,
      ...(Object.keys(choice.binding).length ? { binding: choice.binding } : {})
    }];
  });

  function toggleCapability(group: AuthorizationCapabilityGroup) {
    if (group.required) return;
    setOperations((current) => toggleAuthorizationGroup(current, group));
  }

  function togglePeoplePermission(permission: string) {
    if (!people?.optional?.some((candidate) => candidate === permission)) return;
    setPeoplePermissions((current) => {
      const next = new Set(current);
      if (!next.delete(permission)) next.add(permission);
      return next;
    });
  }

  function toggleFileAction(action: ApplicationFileAction) {
    setFileActions((current) => {
      const next = new Set(current);
      if (next.has(action)) next.delete(action);
      else next.add(action);
      return next;
    });
  }

  function chooseCollection(id: string) {
    setCollectionId(id);
    setCollectionConfirmed(true);
    setLostCollection("");
  }

  async function decide(decision: "approved" | "denied") {
    const preparingSetup = decision === "approved" && hasSetup;
    if (preparingSetup) onSetupActivityChange?.(true);
    setSubmitting(decision);
    setError("");
    onDecisionError("");
    try {
      await api(`/v1/authorization-requests/${request.id}/${decision === "approved" ? "approve" : "deny"}`, {
        method: "POST",
        ...(decision === "approved" ? {
          body: JSON.stringify({
            collection_id: collectionId,
            ...(selected?.offer_id ? { offer_id: selected.offer_id } : {}),
            operations: [...operations],
            ...(request.requirements.files ? { file_actions: [...fileActions] } : {}),
            ...(people ? { people_permissions: [...peoplePermissions] } : {}),
            contract_setups: privateCollection ? [] : contractSetups
          })
        } : {})
      });
      clearAuthorizationReview(request.id);
      await onDecision(decision);
    } catch (decisionError) {
      if (preparingSetup) onSetupActivityChange?.(false);
      onDecisionError(message(decisionError));
      setSubmitting(null);
    }
  }

  async function createHostedCollection(event: React.FormEvent) {
    event.preventDefault();
    const displayName = collectionName.trim();
    if (!displayName) return;
    setSubmitting("creating");
    setError("");
    try {
      const created = await api<{ collection: HostedCollection }>("/v1/hosted/collections", {
        method: "POST",
        body: JSON.stringify({
          display_name: displayName,
          template: "mdbase",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        })
      });
      const collection: AvailableCollection = {
        id: created.collection.id,
        display_name: created.collection.display_name,
        connector_name: t(i18n)`Hosted by mdbase`,
        spec_version: created.collection.spec_version ?? "0.3.0",
        contracts: [],
        types: [],
        kind: "hosted"
      };
      setCreatedCollections((current) => [...current, collection]);
      onCollectionCreated(collection);
      chooseCollection(collection.id);
      setReviewing(true);
      setCollectionName("");
      setCreatingHosted(false);
    } catch (creationError) {
      setError(message(creationError));
    } finally {
      setSubmitting(null);
    }
  }

  const denyButton = <button className="button secondary deny-button" type="button" disabled={submitting !== null} onClick={() => void decide("denied")}>{submitting === "denied" ? t(i18n)({ message: "Denying…", context: "Application access approval" }) : t(i18n)({ message: "Deny", context: "Application access approval" })}</button>;

  return (
    <div className="approval-form" aria-busy={submitting !== null}>
      {!reviewing && <section className="approval-section" aria-labelledby={`requested-${request.id}`}>
        <h2 className="approval-section-title" id={`requested-${request.id}`}><Trans>Requests</Trans></h2>
        <RequestedAccessSummary groups={requestedPermissionGroups} files={request.requirements.files} people={people} />
        {requestSetupSummary.length > 0 && <p className="approval-section-note">{requestSetupSummary.join(". ")}.</p>}
      </section>}
      <section className="approval-section" aria-labelledby={`collection-${request.id}`}>
        <h2 className="approval-section-title" id={`collection-${request.id}`}>{reviewing ? t(i18n)({ message: "Collection", context: "Application access approval" }) : t(i18n)({ message: "Choose a collection", context: "Application access approval" })}</h2>
        {lostCollection && <p className="message error compact" role="alert">{lostCollection}</p>}
        {reviewing && selected ? <div className="selected-collection-summary">
          <div>
            <strong>{selected.display_name}</strong>
            <small>{collectionLocations.get(selected.id)}</small>
          </div>
          {existingOperations.size > 0 && <span className="collection-status"><Trans><i aria-hidden="true" />Already connected</Trans></span>}
          {!request.collection_id && <button className="quiet-action" type="button" disabled={submitting !== null} onClick={() => {
            focusCollectionOnReturn.current = true;
            setReviewing(false);
          }}><Trans>Change</Trans></button>}
        </div> : <>
          {compatible.length > 0 && <fieldset className="collection-choice-field" ref={collectionChoicesRef}>
            <legend className="sr-only"><Trans>Collection</Trans></legend>
            <div className="collection-choice-list">
              {compatible.map(({ collection }) => {
                const connected = request.existing_access?.some((access) => access.collection_id === collection.id);
                return <label className={collection.id === collectionId ? "selected" : undefined} key={collection.id}>
                  <input
                    type="radio"
                    name={`collection-${request.id}`}
                    value={collection.id}
                    checked={collection.id === collectionId}
                    disabled={submitting !== null}
                    onChange={() => chooseCollection(collection.id)}
                  />
                  <span className="collection-choice-copy">
                    <strong>{collection.display_name}</strong>
                    <small>{collectionLocations.get(collection.id)}</small>
                  </span>
                  {connected && <span className="collection-status"><Trans><i aria-hidden="true" />Already connected</Trans></span>}
                </label>;
              })}
            </div>
          </fieldset>}
          {compatible.length === 0 && <p className="field-note">{request.collection_id
            ? t(i18n)({ message: "The collection requested by this application is not available." })
            : request.requirements.collection_kind === "hosted"
              ? t(i18n)({ message: "This application needs a collection hosted by mdbase, and none is ready yet." })
              : t(i18n)({ message: "No compatible collection is ready." })}</p>}
          {(unavailable.length > 0
            || unavailableConnectors.length > 0
            || (request.requirements.collection_kind !== "hosted" && !request.collection_id)
            || (canCreateHosted && !request.collection_id)) && <details
              className="alternate-collection-options"
              open={compatible.length === 0 || creatingHosted || showAlternateCollections}
              onToggle={(event) => {
                if (compatible.length > 0 && !creatingHosted) {
                  setShowAlternateCollections(event.currentTarget.open);
                }
              }}
            >
            <summary>{compatible.length > 0 ? t(i18n)({ message: "Add or connect another collection" }) : t(i18n)({ message: "Choose another way", context: "Application access approval" })}</summary>
            <div>
              {unavailable.length > 0 && <div className="collection-compatibility">
                <strong>{plural(unavailable.length, { one: "# collection is unavailable", other: "# collections are unavailable" })}</strong>
                <ul>{unavailable.map(({ collection, compatibility }) => <li key={collection.id}><span>{collection.display_name}</span><small>{compatibility.compatible ? "" : compatibility.detail}</small></li>)}</ul>
              </div>}
              {unavailableConnectors.length > 0 && <p className="field-note" role="status"><Trans>
                {unavailableConnectors.map((connector) => connector.reason === "paused"
                  ? t(i18n)`${connector.connector_name} has remote access paused.`
                  : t(i18n)`${connector.connector_name} is offline.`).join(" ")} Those local collections cannot be selected until their computer is available.
              </Trans></p>}
              {request.requirements.collection_kind !== "hosted"
                && !request.collection_id
                && <div className="alternate-collection-row">
                  <div>
                    <strong><Trans>Use a folder on this computer</Trans></strong>
                    <small><Trans>Open the desktop app to connect this computer, add a folder, and continue this same request.</Trans></small>
                  </div>
                  <a
                    className="button secondary link-button"
                    href={`mdbase-connect://authorize?request_id=${encodeURIComponent(request.id)}`}
                    onClick={onContinueInDesktop}
                  ><Trans>Use a local folder</Trans></a>
                </div>}
              {canCreateHosted && !request.collection_id && (creatingHosted ? (
                <form
                  className="authorization-collection-create"
                  id={`create-hosted-${request.id}`}
                  onSubmit={(event) => void createHostedCollection(event)}
                >
                  <label>
                    <span><Trans>New collection name</Trans></span>
                    <input
                      autoFocus
                      maxLength={200}
                      value={collectionName}
                      disabled={submitting !== null}
                      placeholder={t(i18n)`Workouts`}
                      onChange={(event) => setCollectionName(event.target.value)}
                    />
                  </label>
                  <small><Trans>Creates a plain mdbase collection hosted by mdbase. Application access is still approved separately.</Trans></small>
                  <div>
                    <button
                      className="quiet-action"
                      type="button"
                      disabled={submitting !== null}
                      onClick={() => {
                        focusHostedTriggerOnCancel.current = true;
                        setCreatingHosted(false);
                        setCollectionName("");
                        setError("");
                      }}
                    ><Trans>Cancel</Trans></button>
                    <button className="button secondary" disabled={submitting !== null || !collectionName.trim()}>
                      {submitting === "creating" ? t(i18n)({ message: "Creating…", context: "Application access approval" }) : t(i18n)({ message: "Create collection", context: "Application access approval" })}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="alternate-collection-row">
                  <div>
                    <strong><Trans>Create a hosted collection</Trans></strong>
                    <small><Trans>A new collection stored by mdbase, available from any computer.</Trans></small>
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    ref={createHostedTriggerRef}
                    aria-controls={`create-hosted-${request.id}`}
                    disabled={submitting !== null}
                    onClick={() => {
                      setCreatingHosted(true);
                      setError("");
                    }}
                  ><Trans>Create hosted collection</Trans></button>
                </div>
              ))}
            </div>
          </details>}
          {error && <div className="message error compact" role="alert">{error}</div>}
          <footer className="approval-footer">
            <p className="approval-receipt" id={`collection-selection-help-${request.id}`}>
              {!collectionId && compatible.length > 0 ? t(i18n)({ message: "Select a collection to continue." }) : t(i18n)({ message: "Nothing is allowed until you review access." })}
            </p>
            <div className="approval-actions">
              {denyButton}
              <button
                className="button primary"
                type="button"
                aria-describedby={`collection-selection-help-${request.id}`}
                disabled={submitting !== null || !collectionId || !collectionConfirmed}
                onClick={() => setReviewing(true)}
              ><Trans>Review access</Trans></button>
            </div>
          </footer>
        </>}
      </section>
      {reviewing && <section className="approval-section" aria-labelledby={`permissions-${request.id}`}>
        <h2 className="approval-section-title" id={`permissions-${request.id}`}><Trans>What it can do</Trans></h2>
        <p className="approval-section-note"><Trans>
          Covers every record in {selected?.display_name ?? t(i18n)({ message: "this collection", context: "Application access approval" })}.
          {existingOperations.size > 0 ? t(i18n)({ message: " Permissions this application does not already have are marked New." }) : ""}
        </Trans></p>
        <PermissionList
          groups={permissionGroups}
          selected={operations}
          existingOperations={existingOperations}
          files={request.requirements.files}
          selectedFiles={fileActions}
          allowedFileActions={allowedFiles}
          people={people}
          selectedPeople={peoplePermissions}
          disabled={submitting !== null}
          onToggleGroup={toggleCapability}
          onToggleFile={toggleFileAction}
          onTogglePeople={togglePeoplePermission}
        />
      </section>}
      {reviewing && hasSetup && <section className="approval-section" aria-labelledby={`changes-${request.id}`}>
        <h2 className="approval-section-title" id={`changes-${request.id}`}><Trans>Collection changes</Trans></h2>
        <div className="contract-setup-list">
          {setup.length > 0 && <ul className="configuration-setup-list">
            {setup.map((provision) => (
              <li className="configuration-setup-item" key={provision.manifest.id}>
                <span aria-hidden="true">+</span>
                <div>
                  <strong>{provision.manifest.name ?? provision.manifest.id} <code>{provision.manifest.version}</code></strong>
                  <small>{provision.manifest.description ?? t(i18n)({ message: "Install or update the application definitions declared by this version." })}</small>
                  {provision.manifest.resources.some((resource) => resource.upgrade_from) && <small><Trans>Upgrades starter types this application added earlier while keeping your customizations and notes. Types it cannot trace to one of those starters are left unchanged. Conflicts, or other types still using the old contract, stop the whole upgrade.</Trans></small>}
                </div>
              </li>
            ))}
          </ul>}
          {setupContracts.map((contract) => {
            const key = `${contract.id}@${contract.version}`;
            const choice = setupChoices[key];
            return choice && <ContractSetupEditor
              key={key}
              applicationName={request.application_name}
              contract={contract}
              types={setupTypes}
              value={choice}
              disabled={submitting !== null}
              onChange={(next) => setSetupChoices((current) => ({ ...current, [key]: next }))}
            />;
          })}
          {configurationSetup.length > 0 && <ul className="configuration-setup-list">
            {configurationSetup.map((provision) => {
              const summary = configurationSetupSummary(provision);
              return <li className="configuration-setup-item" key={`${provision.requirement}:${provision.path}`}>
                <span aria-hidden="true">+</span>
                <div>
                  <strong><Trans>Ensure <code>{summary.setting}</code> includes <code>{summary.value}</code></Trans></strong>
                  <small><Trans>If the value is already present, mdbase leaves the collection unchanged. Conflicting settings stop setup without overwriting policy.</Trans></small>
                </div>
              </li>;
            })}
          </ul>}
        </div>
      </section>}
      {reviewing && <NotificationAccess applicationName={request.application_name} notifications={request.notifications} />}
      {reviewing && error && <div className="message error compact" role="alert">{error}</div>}
      {reviewing && <footer className="approval-footer">
        <div className="approval-receipt">
          <p>{request.distribution === "portable"
            ? t(i18n)`${request.application_name} can use ${selectedName} while it remains connected. You can revoke access in mdbase connect.`
            : t(i18n)`${request.application_name} can use ${selectedName} until you revoke access in mdbase connect.`}</p>
          {privateCollection && <p><Trans>This is a Private collection: it stays on your computer. {request.application_name} can use it while a computer that has it is running mdbase and is signed in to your account.</Trans></p>}
          {higherImpactLabels.length > 0 && <p className="receipt-impact"><Trans><i aria-hidden="true" />Includes {higherImpactLabels.join(", ")}.</Trans></p>}
          {approvalBlocker && <p className="receipt-blocker" id={blockerId}>{approvalBlocker}</p>}
        </div>
        <div className="approval-actions">
          {denyButton}
          <button
            className="button primary"
            type="button"
            aria-describedby={approvalBlocker ? blockerId : undefined}
            disabled={submitting !== null || !collectionId || !collectionConfirmed || Boolean(approvalBlocker)}
            onClick={() => void decide("approved")}
          >{submitting === "approved" ? (hasSetup ? t(i18n)({ message: "Setting up and allowing…", context: "Application access approval" }) : t(i18n)({ message: "Allowing…", context: "Application access approval" })) : hasSetup ? t(i18n)({ message: "Set up and allow access", context: "Application access approval" }) : t(i18n)({ message: "Allow access", context: "Application access approval" })}</button>
        </div>
      </footer>}
    </div>
  );
}

function authorizationNeedsSetup(
  request: PendingAuthorization,
  collections: AvailableCollection[]
): boolean {
  if (!request.collection_id) return false;
  const collection = collections.find((candidate) => candidate.id === request.collection_id);
  if (!collection) return false;
  return (request.provisions.configuration?.length ?? 0) > 0
    || request.provisions.type_packs.length > 0
    || request.requirements.contracts.some((required) =>
      !collection.contracts.some((contract) =>
        contract.id === required.id
          && contract.version === required.version
          && contract.digest === required.digest
      ) && Boolean(provisionedContract(required, request.provisions.type_packs))
    );
}
