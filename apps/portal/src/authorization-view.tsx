import { provisionedContract, type SetupType } from "@mdbase/connect-ui/contract-setup";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { collectionCompatibility } from "./compatibility";
import {
  authorizationCapabilityGroups,
  authorizationRequirementsError,
  toggleAuthorizationGroup,
  selectedFileActions,
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
  const initialCode = formatDeviceCode(new URLSearchParams(location.search).get("user_code") ?? "");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const automaticallyClaimed = useRef(false);

  async function openRequest(value: string) {
    const userCode = formatDeviceCode(value);
    if (userCode.replace("-", "").length !== 8) {
      setError("Enter the eight-character code shown by the application.");
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
      <PageBrand label="Application connection" />
      <form className="decision-panel device-panel" onSubmit={(event) => {
        event.preventDefault();
        void openRequest(code);
      }}>
        <p className="eyebrow">Short approval code</p>
        <h1>Check the application.</h1>
        <p>Enter the code it shows. You will review the application, collection, and exact permissions before anything is allowed.</p>
        <label className="device-code-field">
          <span>Approval code</span>
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
        <p className="field-note">Codes are not case-sensitive, expire after ten minutes, and can authorize only the key created by that application.</p>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="button primary" disabled={busy || code.replace("-", "").length !== 8}>
          {busy ? "Checking…" : "Review request"}
        </button>
      </form>
    </main>
  );
}

type RequestStatus = "pending" | "setting_up" | "approved" | "denied" | "expired";

export function Authorization({ requestId }: { requestId: string }) {
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
        <PageBrand label="Application request" />
        <section className="decision-panel authorization-panel">
          <RequestOutcome status="expired" applicationName="the application" standalone />
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
        label="Application request"
        markMotion={setupMotionActive ? (preparingStructure ? "rebalance" : "conveyor") : undefined}
      />
      <section className="decision-panel authorization-panel">
        <RequestIdentity request={authorization} />
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
    ? <a className="button secondary link-button outcome-return" href={returnUrl}>Return to {applicationName}</a>
    : null;
  if (status === "expired") return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label">Request unavailable</p>
    <Heading>This request has expired or was already answered.</Heading>
    <p>Return to {applicationName} and connect again to start a new request.</p>
  </div>;
  if (status === "setting_up") return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label">Approval recorded</p>
    <h2>Finishing collection setup…</h2>
    <p>Your choices are being checked with the collection’s main copy. The application does not have access yet.</p>
    {late && <p>This is taking longer than usual. Keep this page open; it continues automatically when setup finishes.</p>}
  </div>;
  const approved = status === "approved";
  return <div className="request-outcome" role="status">
    <p className="eyebrow outcome-label">{approved ? "Access approved" : "Access denied"}</p>
    <h2>{portable ? `Return to ${applicationName}.` : `Returning to ${applicationName}…`}</h2>
    <p>{portable
      ? approved
        ? "The application will finish connecting with its one-time device code. You can close this window."
        : "The application will learn that access was not granted. You can close this window."
      : approved
        ? "Your approved collection and permissions will follow you back."
        : "The application will show that access was not granted."}</p>
    {returnLink}
  </div>;
}

export function RequestIdentity({ request }: { request: PendingAuthorization }) {
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
          ? <>Application using a device code{request.project_url && <> · <code>{host(request.project_url)}</code></>}</>
          : <code>{host(request.homepage)}</code>}</p>
        {portable
          ? <p className="request-guidance portable-authorization-warning" role="note"><strong>Application origin unverified.</strong> Continue only if you started this connection intentionally{request.user_code ? <> and it shows <code>{request.user_code}</code></> : null}.{request.project_url ? <> {host(request.project_url)} does not verify its origin.</> : null}</p>
          : <p className="request-guidance">Only continue if you recognize this exact site.</p>}
        <p className="request-expiry">Request expires {relativeTime(request.expires_at)}</p>
      </div>
    </header>
  );
}

function DesktopContinuation({ request, onReviewHere }: {
  request: PendingAuthorization;
  onReviewHere(): void;
}) {
  const desktopUrl = `mdbase-connect://authorize?request_id=${encodeURIComponent(request.id)}`;
  return (
    <section className="desktop-continuation" aria-live="polite">
      <h2>Choose the folder in mdbase connect.</h2>
      <p>This request remains open while you connect the computer or add a collection. Approve it in the desktop app, then return here to continue to {request.application_name}.</p>
      <div className="desktop-continuation-status">
        <span className="status-dot connecting" aria-hidden="true" />
        <div><strong>Waiting for mdbase connect</strong><small>The page will notice when the request is approved.</small></div>
      </div>
      <div className="approval-actions">
        <button className="button secondary" type="button" onClick={onReviewHere}>Review in this browser</button>
        <a className="button primary link-button" href={desktopUrl}>Open mdbase connect</a>
      </div>
      <p className="field-note">If the desktop app does not open, <a href="https://mdbase.dev/downloads/" target="_blank" rel="noreferrer">install the current Connect release</a>, then return to this page. The request expires {relativeTime(request.expires_at)}.</p>
    </section>
  );
}

export function ApprovalForm(props: React.ComponentProps<typeof SupportedApprovalForm>) {
  const error = authorizationRequirementsError(props.request.requirements);
  if (error) return <div className="message error" role="alert">{error}</div>;
  return <SupportedApprovalForm {...props} />;
}

function lostCollectionNotice(
  collection: AvailableCollection,
  unavailable: Array<{ collection: AvailableCollection; compatibility: ReturnType<typeof collectionCompatibility> }>,
  unavailableConnectors: UnavailableConnector[]
): string {
  const incompatible = unavailable.find((choice) => choice.collection.id === collection.id)?.compatibility;
  if (incompatible && !incompatible.compatible) {
    return `${collection.display_name} can no longer be used: ${incompatible.detail} Choose another collection.`;
  }
  const connector = unavailableConnectors.find((candidate) => candidate.connector_name === collection.connector_name);
  if (connector) {
    return `${collection.display_name} is unavailable because ${connector.connector_name} ${connector.reason === "paused" ? "has remote access paused" : "is offline"}. Choose another collection.`;
  }
  return `${collection.display_name} is no longer available. Choose another collection.`;
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
  }, [collections, createdCollections, request]);
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
  const requestedPermissionGroups = useMemo(
    () => authorizationCapabilityGroups(
      request.requirements,
      request.requested_operations
    ),
    [request.requirements, request.requested_operations]
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
    const selected = selectedOperationsForCapabilityGroups(
      requestedPermissionGroups,
      savedReview?.operations
    );
    const grouped = new Set(requestedPermissionGroups.flatMap((group) => group.operations));
    for (const operation of request.requested_operations) {
      if (!grouped.has(operation) && (!savedReview?.operations
        || request.requirements.capabilities?.contract_version === 2
        || savedReview.operations.includes(operation))) selected.add(operation);
    }
    return selected;
  });
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
  const approval = selected?.authorization;
  const allowedOperations = approval?.available ? approval.operations : undefined;
  const allowedFiles = approval?.available ? approval.file_actions : undefined;
  const permissionGroups = useMemo(() => requestedPermissionGroups.filter((group) =>
    !allowedOperations || group.operations.every((operation) => allowedOperations.includes(operation))
  ), [allowedOperations, requestedPermissionGroups]);
  const operations = useMemo(() => new Set([...chosenOperations].filter((operation) =>
    !allowedOperations || allowedOperations.includes(operation)
  )), [allowedOperations, chosenOperations]);
  const fileActions = useMemo(() => new Set([...chosenFileActions].filter((action) =>
    !allowedFiles || allowedFiles.includes(action as ApplicationFileAction)
  )), [allowedFiles, chosenFileActions]);
  const existingOperations = useMemo(() => new Set(request.existing_access?.find((access) =>
    access.collection_id === collectionId)?.operations ?? []), [collectionId, request.existing_access]);
  const setup = selected ? neededProvisions(request, selected) : [];
  const configurationSetup = request.provisions.configuration ?? [];
  const hasSetup = setup.length > 0 || configurationSetup.length > 0;
  const requestSetupSummary = [
    ...(request.provisions.type_packs.length > 0
      ? [`Adds ${provisionNames(request.provisions.type_packs)} to the collection`]
      : []),
    ...(configurationSetup.length > 0 ? ["Changes collection settings"] : [])
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
    + (fileActions.size > 0 ? 1 : 0);
  const higherImpactLabels = [
    ...selectedPermissionGroups.flatMap((group) =>
      group.higherImpact ? [group.label.toLocaleLowerCase()] : []
    ),
    ...(fileActions.has("delete") ? ["delete files"] : []),
    ...(hasSetup ? ["changes to collection setup"] : [])
  ];
  const approvalBlocker = selectedPermissionCount === 0 && !request.requirements.files
    ? "Allow at least one permission to continue."
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
      reviewing
    });
  }, [collectionConfirmed, collectionId, fileActions, operations, request.id, reviewing]);

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
            contract_setups: contractSetups
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
        connector_name: "Hosted by mdbase",
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

  const denyButton = <button className="button secondary deny-button" type="button" disabled={submitting !== null} onClick={() => void decide("denied")}>{submitting === "denied" ? "Denying…" : "Deny"}</button>;

  return (
    <div className="approval-form" aria-busy={submitting !== null}>
      {!reviewing && <section className="approval-section" aria-labelledby={`requested-${request.id}`}>
        <h2 className="approval-section-title" id={`requested-${request.id}`}>Requests</h2>
        <RequestedAccessSummary groups={requestedPermissionGroups} files={request.requirements.files} />
        {requestSetupSummary.length > 0 && <p className="approval-section-note">{requestSetupSummary.join(". ")}.</p>}
      </section>}
      <section className="approval-section" aria-labelledby={`collection-${request.id}`}>
        <h2 className="approval-section-title" id={`collection-${request.id}`}>{reviewing ? "Collection" : "Choose a collection"}</h2>
        {lostCollection && <p className="message error compact" role="alert">{lostCollection}</p>}
        {reviewing && selected ? <div className="selected-collection-summary">
          <div>
            <strong>{selected.display_name}</strong>
            <small>{collectionLocations.get(selected.id)}</small>
          </div>
          {existingOperations.size > 0 && <span className="collection-status"><i aria-hidden="true" />Already connected</span>}
          {!request.collection_id && <button className="quiet-action" type="button" disabled={submitting !== null} onClick={() => {
            focusCollectionOnReturn.current = true;
            setReviewing(false);
          }}>Change</button>}
        </div> : <>
          {compatible.length > 0 && <fieldset className="collection-choice-field" ref={collectionChoicesRef}>
            <legend className="sr-only">Collection</legend>
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
                  {connected && <span className="collection-status"><i aria-hidden="true" />Already connected</span>}
                </label>;
              })}
            </div>
          </fieldset>}
          {compatible.length === 0 && <p className="field-note">{request.collection_id
            ? "The collection requested by this application is not available."
            : request.requirements.collection_kind === "hosted"
              ? "This application needs a collection hosted by mdbase, and none is ready yet."
              : "No compatible collection is ready."}</p>}
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
            <summary>{compatible.length > 0 ? "Add or connect another collection" : "Choose another way"}</summary>
            <div>
              {unavailable.length > 0 && <div className="collection-compatibility">
                <strong>{unavailable.length} {unavailable.length === 1 ? "collection is" : "collections are"} unavailable</strong>
                <ul>{unavailable.map(({ collection, compatibility }) => <li key={collection.id}><span>{collection.display_name}</span><small>{compatibility.compatible ? "" : compatibility.detail}</small></li>)}</ul>
              </div>}
              {unavailableConnectors.length > 0 && <p className="field-note" role="status">
                {unavailableConnectors.map((connector) => connector.reason === "paused"
                  ? `${connector.connector_name} has remote access paused.`
                  : `${connector.connector_name} is offline.`).join(" ")} Those local collections cannot be selected until their computer is available.
              </p>}
              {request.requirements.collection_kind !== "hosted"
                && !request.collection_id
                && <div className="alternate-collection-row">
                  <div>
                    <strong>Use a folder on this computer</strong>
                    <small>Open the desktop app to connect this computer, add a folder, and continue this same request.</small>
                  </div>
                  <a
                    className="button secondary link-button"
                    href={`mdbase-connect://authorize?request_id=${encodeURIComponent(request.id)}`}
                    onClick={onContinueInDesktop}
                  >Use a local folder</a>
                </div>}
              {canCreateHosted && !request.collection_id && (creatingHosted ? (
                <form
                  className="authorization-collection-create"
                  id={`create-hosted-${request.id}`}
                  onSubmit={(event) => void createHostedCollection(event)}
                >
                  <label>
                    <span>New collection name</span>
                    <input
                      autoFocus
                      maxLength={200}
                      value={collectionName}
                      disabled={submitting !== null}
                      placeholder="Workouts"
                      onChange={(event) => setCollectionName(event.target.value)}
                    />
                  </label>
                  <small>Creates a plain mdbase collection hosted by mdbase. Application access is still approved separately.</small>
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
                    >Cancel</button>
                    <button className="button secondary" disabled={submitting !== null || !collectionName.trim()}>
                      {submitting === "creating" ? "Creating…" : "Create collection"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="alternate-collection-row">
                  <div>
                    <strong>Create a hosted collection</strong>
                    <small>A new collection stored by mdbase, available from any computer.</small>
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
                  >Create hosted collection</button>
                </div>
              ))}
            </div>
          </details>}
          {error && <div className="message error compact" role="alert">{error}</div>}
          <footer className="approval-footer">
            <p className="approval-receipt" id={`collection-selection-help-${request.id}`}>
              {!collectionId && compatible.length > 0 ? "Select a collection to continue." : "Nothing is allowed until you review access."}
            </p>
            <div className="approval-actions">
              {denyButton}
              <button
                className="button primary"
                type="button"
                aria-describedby={`collection-selection-help-${request.id}`}
                disabled={submitting !== null || !collectionId || !collectionConfirmed}
                onClick={() => setReviewing(true)}
              >Review access</button>
            </div>
          </footer>
        </>}
      </section>
      {reviewing && <section className="approval-section" aria-labelledby={`permissions-${request.id}`}>
        <h2 className="approval-section-title" id={`permissions-${request.id}`}>What it can do</h2>
        <p className="approval-section-note">
          Covers every record in {selected?.display_name ?? "this collection"}.
          {existingOperations.size > 0 ? " Permissions this application does not already have are marked New." : ""}
        </p>
        <PermissionList
          groups={permissionGroups}
          selected={operations}
          existingOperations={existingOperations}
          files={request.requirements.files}
          selectedFiles={fileActions}
          allowedFileActions={allowedFiles}
          disabled={submitting !== null}
          onToggleGroup={toggleCapability}
          onToggleFile={toggleFileAction}
        />
      </section>}
      {reviewing && hasSetup && <section className="approval-section" aria-labelledby={`changes-${request.id}`}>
        <h2 className="approval-section-title" id={`changes-${request.id}`}>Collection changes</h2>
        <div className="contract-setup-list">
          {setup.length > 0 && <ul className="configuration-setup-list">
            {setup.map((provision) => (
              <li className="configuration-setup-item" key={provision.manifest.id}>
                <span aria-hidden="true">+</span>
                <div>
                  <strong>{provision.manifest.name ?? provision.manifest.id} <code>{provision.manifest.version}</code></strong>
                  <small>{provision.manifest.description ?? "Install or update the application definitions declared by this version."}</small>
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
                  <strong>Ensure <code>{summary.setting}</code> includes <code>{summary.value}</code></strong>
                  <small>If the value is already present, mdbase leaves the collection unchanged. Conflicting settings stop setup without overwriting policy.</small>
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
          <p>{request.application_name} can use {selected?.display_name ?? "this collection"} until you revoke access in mdbase connect.</p>
          {higherImpactLabels.length > 0 && <p className="receipt-impact"><i aria-hidden="true" />Includes {higherImpactLabels.join(", ")}.</p>}
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
          >{submitting === "approved" ? (hasSetup ? "Setting up and allowing…" : "Allowing…") : hasSetup ? "Set up and allow access" : "Allow access"}</button>
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
