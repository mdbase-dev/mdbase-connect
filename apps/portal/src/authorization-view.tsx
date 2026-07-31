import { groupAuthorizationOperations } from "@mdbase/connect-ui/access";
import {
  assessMapping,
  contractFields,
  guidedBindingSupported,
  propertyFields,
  provisionedContract,
  setupLabel,
  suggestTypes,
  typeFields,
  type SetupContract,
  type SetupType
} from "@mdbase/connect-ui/contract-setup";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type AvailableCollection,
  type ContractSetupChoice as ContractSetupRequestChoice,
  type HostedCollection,
  type PendingAuthorization,
  type UnavailableConnector
} from "./api";
import { collectionCompatibility } from "./compatibility";
import {
  formatDeviceCode,
  host,
  initials,
  message,
  neededProvisions,
  provisionNames,
  relativeTime,
  scopeDescription
} from "./portal-model";
import { Loading, PageBrand, useSystemTheme } from "./portal-ui";

export function DeviceAuthorization() {
  const initialCode = formatDeviceCode(new URLSearchParams(location.search).get("user_code") ?? "");
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const automaticallyClaimed = useRef(false);
  useSystemTheme();

  async function openRequest(value: string) {
    const userCode = formatDeviceCode(value);
    if (userCode.replace("-", "").length !== 8) {
      setError("Enter the eight-character code shown by the downloaded application.");
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
      <PageBrand label="Downloaded application" themePicker={false} />
      <form className="decision-panel device-panel" onSubmit={(event) => {
        event.preventDefault();
        void openRequest(code);
      }}>
        <p className="eyebrow">Short approval code</p>
        <h1>Check the downloaded file.</h1>
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
        <p className="field-note">Codes expire after ten minutes and can authorize only the key created by that file.</p>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="button primary" disabled={busy || code.replace("-", "").length !== 8}>
          {busy ? "Checking…" : "Review request"}
        </button>
      </form>
    </main>
  );
}

export function Authorization({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<{
    authorization: PendingAuthorization;
    collections: AvailableCollection[];
    hosted_collections_available?: boolean;
    unavailable_connectors: UnavailableConnector[];
  } | null>(null);
  const [status, setStatus] = useState<"pending" | "setting_up" | "approved" | "denied">("pending");
  const [continuingInDesktop, setContinuingInDesktop] = useState(
    () => new URLSearchParams(location.search).get("continue_in_desktop") === "1"
  );
  const [error, setError] = useState("");
  const returning = useRef(false);
  useSystemTheme();

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
          setRequest(next);
          setError("");
        }
      } catch (reason) {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) {
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        } else if (!(reason instanceof ApiError && reason.status === 404)) {
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
        setStatus(value.status);
        if (value.redirect_uri) {
          returning.current = true;
          location.replace(value.redirect_uri);
        }
      } catch {
        // A transient polling failure should not discard the pending decision.
      }
    }
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [requestId]);

  if (!request) return <Loading error={error} />;
  const authorization = request.authorization;
  function continueInDesktop(value: boolean) {
    const url = new URL(location.href);
    if (value) url.searchParams.set("continue_in_desktop", "1");
    else url.searchParams.delete("continue_in_desktop");
    history.replaceState(history.state, "", url);
    setContinuingInDesktop(value);
  }
  return (
    <main className="center-page">
      <PageBrand label="Application request" themePicker={false} />
      <section className="decision-panel authorization-panel">
        <RequestIdentity request={authorization} large />
        {status === "pending" && continuingInDesktop ? (
          <DesktopContinuation
            request={authorization}
            onReviewHere={() => continueInDesktop(false)}
          />
        ) : status === "pending" ? <>
          <p>{authorization.application_name} is asking to use one collection. Choose where it can work and review what it can do.</p>
          {error && <div className="message error">{error}</div>}
          <ApprovalForm
            request={authorization}
            canCreateHosted={request.hosted_collections_available !== false}
            collections={request.collections}
            unavailableConnectors={request.unavailable_connectors}
            onContinueInDesktop={() => continueInDesktop(true)}
            onDecision={(decision) => setStatus(decision)}
            onCollectionCreated={(collection) => setRequest((current) => current ? {
              ...current,
              collections: current.collections.some((existing) => existing.id === collection.id)
                ? current.collections
                : [...current.collections, collection]
            } : current)}
          />
        </> : status === "setting_up" ? <><p className="eyebrow outcome-label">Approval recorded</p><h2>Finishing collection setup…</h2><p>Your choices are being checked with the collection’s main copy. The application does not have access yet.</p></> : status === "approved" ? <><p className="eyebrow outcome-label">Access approved</p><h2>{authorization.distribution === "portable" ? "Return to the downloaded application." : "Returning to the application…"}</h2><p>{authorization.distribution === "portable" ? "The file will finish connecting with its one-time device code. You can close this window." : "Your approved collection and permissions will follow you back."}</p></> : <><p className="eyebrow outcome-label">Access denied</p><h2>{authorization.distribution === "portable" ? "Return to the downloaded application." : "Returning to the application…"}</h2><p>{authorization.distribution === "portable" ? "The file will learn that access was not granted. You can close this window." : "The application will show that access was not granted."}</p></>}
      </section>
    </main>
  );
}

export function RequestIdentity({ request, large = false }: { request: PendingAuthorization; large?: boolean }) {
  return (
    <div className={`request-identity ${large ? "large" : ""}`}>
      <span aria-hidden="true">{initials(request.application_name)}</span>
      <div>
        {large && <p className="eyebrow">Application access</p>}
        {large ? <h1>{request.application_name}</h1> : <strong>{request.application_name}</strong>}
        <small>{request.distribution === "portable"
          ? `Downloaded HTML file${request.project_url ? ` · ${host(request.project_url)}` : ""}`
          : host(request.homepage)} · expires {relativeTime(request.expires_at)}</small>
        {request.distribution !== "portable" && (
          <small>Only continue if you recognize this exact site. An approved application can use the selected data until you revoke it.</small>
        )}
        {request.requirements.access === "full_collection" ? (
          <small>Requests access to all record types in the selected collection.</small>
        ) : request.requirements.contracts.length > 0 && (
          <small>{scopeDescription(request.requirements.contracts)}</small>
        )}
        {request.requirements.collection_kind === "hosted" && (
          <small>Requires a collection hosted by mdbase</small>
        )}
      </div>
    </div>
  );
}

function DesktopContinuation({ request, onReviewHere }: {
  request: PendingAuthorization;
  onReviewHere(): void;
}) {
  const desktopUrl = `mdbase-connect://authorize?request_id=${encodeURIComponent(request.id)}`;
  return (
    <section className="desktop-continuation" aria-live="polite">
      <p className="eyebrow">Continue on this computer</p>
      <h2>Choose the folder in mdbase connect.</h2>
      <p>This request remains open while you connect the computer or add a collection. Approve it in the desktop app, then return here to continue to {request.application_name}.</p>
      <div className="desktop-continuation-status">
        <span className="status-dot connecting" aria-hidden="true" />
        <div><strong>Waiting for mdbase connect</strong><small>The page will notice when the request is approved.</small></div>
      </div>
      <div className="desktop-continuation-actions">
        <a className="button primary link-button" href={desktopUrl}>Open mdbase connect</a>
        <button className="button secondary" type="button" onClick={onReviewHere}>Review in this browser</button>
      </div>
      <p className="field-note">If the desktop app does not open, <a href="https://github.com/mdbase-dev/mdbase-connect/releases/latest" target="_blank" rel="noreferrer">install the latest release</a>, then return to this page. The request expires {relativeTime(request.expires_at)}.</p>
    </section>
  );
}

interface ContractSetupChoice {
  mode: "starter" | "existing";
  typeName: string;
  fields: Record<string, string>;
  binding: Record<string, unknown>;
}

function initialContractSetupChoice(
  contract: SetupContract,
  types: SetupType[]
): ContractSetupChoice {
  const suggestion = suggestTypes(contract, types)[0];
  return {
    mode: "starter",
    typeName: suggestion?.type.name ?? "",
    fields: suggestion?.fields ?? {},
    binding: initialSchemaValue(contract.binding_schema)
  };
}

function ContractSetupEditor({
  applicationName,
  contract,
  types,
  value,
  disabled,
  onChange
}: {
  applicationName: string;
  contract: SetupContract;
  types: SetupType[];
  value: ContractSetupChoice;
  disabled: boolean;
  onChange(value: ContractSetupChoice): void;
}) {
  const suggestions = useMemo(() => suggestTypes(contract, types), [contract, types]);
  const canGuideExistingType = guidedBindingSupported(contract);
  const selectedType = types.find((type) => type.name === value.typeName);
  const availableFields = selectedType ? typeFields(selectedType) : [];
  const fields = contractFields(contract);
  const bindingFields = contract.binding_schema ? propertyFields(contract.binding_schema) : [];
  const requiredBinding = new Set(
    Array.isArray(contract.binding_schema?.required)
      ? contract.binding_schema.required.filter((field): field is string => typeof field === "string")
      : []
  );

  function selectType(typeName: string) {
    const suggestion = suggestions.find((candidate) => candidate.type.name === typeName);
    onChange({ ...value, typeName, fields: suggestion?.fields ?? {} });
  }

  return (
    <div className="contract-setup-editor">
      <div className="contract-setup-heading">
        <div>
          <strong>Help {applicationName} understand {setupLabel(contract).toLocaleLowerCase()}</strong>
          <small>{contract.description ?? "Choose whether to add the application’s starter type or use one of your existing types."}</small>
        </div>
        <code>{contract.id} · {contract.version}</code>
      </div>
      <div className="contract-setup-mode" role="radiogroup" aria-label={`Setup for ${setupLabel(contract)}`}>
        <label className={value.mode === "starter" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "starter"} disabled={disabled} onChange={() => onChange({ ...value, mode: "starter" })} />
          <span><strong>Add {applicationName}’s starter type</strong><small>Create a separate type supplied by the application.</small></span>
        </label>
        {suggestions.length > 0 && canGuideExistingType && <label className={value.mode === "existing" ? "selected" : undefined}>
          <input type="radio" name={`setup-${contract.id}-${contract.version}`} checked={value.mode === "existing"} disabled={disabled} onChange={() => onChange({ ...value, mode: "existing" })} />
          <span><strong>Use an existing type</strong><small>Keep your current records and explain which fields mean the same thing.</small></span>
        </label>}
      </div>
      {!canGuideExistingType && suggestions.length > 0 && <p className="field-note">This contract has advanced behavior settings. Add its starter type here, or connect an existing type later in mdbase editor.</p>}
      {value.mode === "existing" && canGuideExistingType && <div className="contract-mapping">
        <label className="contract-type-choice">
          <span>Existing type</span>
          <select value={value.typeName} disabled={disabled} onChange={(event) => selectType(event.target.value)}>
            {suggestions.map((suggestion, index) => <option value={suggestion.type.name} key={suggestion.type.name}>{suggestion.type.name}{index === 0 && suggestion.requiredMatched === suggestion.requiredTotal ? " · suggested" : ""}</option>)}
          </select>
        </label>
        <div className="contract-field-list">{fields.map((field) => {
          const mapped = value.fields[field.reference] ?? "";
          const typeField = availableFields.find((candidate) => candidate.reference === mapped);
          const assessment = assessMapping(field, typeField);
          return <label key={field.reference}>
            <span><strong>{field.label}{field.required ? " *" : ""}</strong><small>{field.description ?? `The application’s ${field.label.toLocaleLowerCase()} value.`}</small></span>
            <select value={mapped} disabled={disabled} aria-invalid={assessment.level === "error"} onChange={(event) => {
              const next = { ...value.fields };
              if (event.target.value) next[field.reference] = event.target.value;
              else delete next[field.reference];
              onChange({ ...value, fields: next });
            }}>
              <option value="">{field.required ? "Choose a field" : "Do not share"}</option>
              {availableFields.map((candidate) => <option key={candidate.reference} value={candidate.reference}>{candidate.label}</option>)}
            </select>
            <small className={`mapping-assessment ${assessment.level}`}>{assessment.label} · {assessment.message}</small>
          </label>;
        })}</div>
        {bindingFields.length > 0 && <fieldset className="contract-binding">
          <legend>How this type behaves in {applicationName}</legend>
          {bindingFields.map((field) => <SchemaInput key={field.name} field={field} required={requiredBinding.has(field.name)} value={value.binding[field.name]} disabled={disabled} onChange={(next) => onChange({ ...value, binding: { ...value.binding, [field.name]: next } })} />)}
        </fieldset>}
        <p className="field-note">Only this type definition changes. Existing records stay in place. Setup is validated before access becomes active.</p>
      </div>}
    </div>
  );
}

function SchemaInput({ field, required, value, disabled, onChange }: {
  field: ReturnType<typeof propertyFields>[number];
  required: boolean;
  value: unknown;
  disabled: boolean;
  onChange(value: unknown): void;
}) {
  const options = Array.isArray(field.schema.enum) ? field.schema.enum : undefined;
  return <label>
    <span>{field.label}{required ? " *" : ""}</span>
    {options ? <select value={value === undefined ? "" : String(value)} disabled={disabled} onChange={(event) => onChange(options.find((option) => String(option) === event.target.value))}>
      <option value="">Choose</option>
      {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
    </select> : field.kind === "boolean" ? <input type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /> : <input
      type={field.kind === "number" || field.kind === "integer" ? "number" : "text"}
      value={typeof value === "string" || typeof value === "number" ? value : ""}
      disabled={disabled}
      onChange={(event) => onChange(field.kind === "number" || field.kind === "integer" ? event.target.value === "" ? undefined : Number(event.target.value) : event.target.value)}
    />}
    {field.description && <small>{field.description}</small>}
  </label>;
}

function initialSchemaValue(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || !schema.properties || typeof schema.properties !== "object") return {};
  return Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>).flatMap(
    ([key, candidate]) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const value = candidate as Record<string, unknown>;
      return "default" in value ? [[key, structuredClone(value.default)]] : [];
    }
  ));
}

export function ApprovalForm({
  request,
  collections,
  canCreateHosted,
  unavailableConnectors = [],
  onContinueInDesktop,
  onDecision,
  onCollectionCreated
}: {
  request: PendingAuthorization;
  collections: AvailableCollection[];
  canCreateHosted: boolean;
  unavailableConnectors?: UnavailableConnector[];
  onContinueInDesktop?(): void;
  onDecision(decision: "approved" | "denied"): void | Promise<void>;
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
  const [collectionId, setCollectionId] = useState(
    compatible[0]?.collection.id ?? ""
  );
  const [operations, setOperations] = useState(() => new Set(request.requested_operations));
  const [submitting, setSubmitting] = useState<"approved" | "denied" | "creating" | null>(null);
  const [creatingHosted, setCreatingHosted] = useState(false);
  const [collectionName, setCollectionName] = useState("");
  const [error, setError] = useState("");
  const selected = compatible.find((choice) => choice.collection.id === collectionId)?.collection;
  const setup = selected ? neededProvisions(request, selected) : [];
  const setupContracts = useMemo(() => selected
    ? request.requirements.contracts.flatMap((required) => {
        if (selected.contracts.some((contract) =>
          contract.id === required.id && contract.version === required.version)) return [];
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
  const permissionGroups = useMemo(
    () => groupAuthorizationOperations(request.requested_operations),
    [request.requested_operations]
  );
  const permissionCount = permissionGroups.reduce(
    (count, group) => count + group.operations.length,
    0
  );
  const selectedPermissionCount = permissionGroups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => operations.has(operation.id)).length,
    0
  );

  useEffect(() => {
    if (!compatible.some((choice) => choice.collection.id === collectionId)) {
      setCollectionId(compatible[0]?.collection.id ?? "");
    }
  }, [collectionId, compatible]);

  useEffect(() => {
    setSetupChoices(Object.fromEntries(setupContracts.map((contract) => [
      `${contract.id}@${contract.version}`,
      initialContractSetupChoice(contract, setupTypes)
    ])));
  }, [setupIdentity]);

  const setupReady = setupContracts.every((contract) => {
    const choice = setupChoices[`${contract.id}@${contract.version}`];
    if (!choice) return false;
    if (choice.mode === "starter") return true;
    const type = setupTypes.find((candidate) => candidate.name === choice.typeName);
    if (!type?.revision) return false;
    const available = typeFields(type);
    if (contractFields(contract).some((field) => {
      const mapped = choice.fields[field.reference];
      const candidate = available.find((value) => value.reference === mapped);
      return assessMapping(field, candidate).level === "error";
    })) return false;
    const requiredBinding = Array.isArray(contract.binding_schema?.required)
      ? contract.binding_schema.required.filter((field): field is string => typeof field === "string")
      : [];
    return requiredBinding.every((field) => {
      const value = choice.binding[field];
      return value !== undefined && value !== null && value !== "";
    });
  });

  const contractSetups = setupContracts.flatMap<ContractSetupRequestChoice>((contract) => {
    const choice = setupChoices[`${contract.id}@${contract.version}`];
    if (!choice) return [];
    if (choice.mode === "starter") return [{
      contract: { id: contract.id, version: contract.version },
      mode: "starter" as const
    }];
    const type = setupTypes.find((candidate) => candidate.name === choice.typeName);
    if (!type?.revision) return [];
    return [{
      contract: { id: contract.id, version: contract.version },
      mode: "existing" as const,
      type_name: type.name,
      type_revision: type.revision,
      fields: choice.fields,
      ...(Object.keys(choice.binding).length ? { binding: choice.binding } : {})
    }];
  });

  function toggleOperation(operation: string) {
    setOperations((current) => {
      const next = new Set(current);
      if (next.has(operation)) next.delete(operation);
      else next.add(operation);
      return next;
    });
  }

  async function decide(decision: "approved" | "denied") {
    setSubmitting(decision);
    setError("");
    try {
      await api(`/v1/authorization-requests/${request.id}/${decision === "approved" ? "approve" : "deny"}`, {
        method: "POST",
        ...(decision === "approved" ? {
          body: JSON.stringify({
            collection_id: collectionId,
            ...(selected?.offer_id ? { offer_id: selected.offer_id } : {}),
            operations: [...operations],
            contract_setups: contractSetups
          })
        } : {})
      });
      await onDecision(decision);
    } catch (decisionError) {
      setError(message(decisionError));
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
          template: "mdbase"
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
      setCollectionId(collection.id);
      setCollectionName("");
      setCreatingHosted(false);
    } catch (creationError) {
      setError(message(creationError));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="approval-form" aria-busy={submitting !== null}>
      {request.distribution === "portable" && <div className="portable-authorization-warning" role="note">
        <div>
          <p className="eyebrow">Downloaded file, unverified origin</p>
          <strong>Only continue if you intentionally opened this HTML file.</strong>
        </div>
        {request.user_code && <p>Confirm that it shows <code>{request.user_code}</code>. The code binds this approval to the file’s one-time device request.</p>}
        <p>{request.project_url
          ? `${host(request.project_url)} is a developer-supplied project link, not proof that the downloaded file came from that site.`
          : "A downloaded file has no website origin that mdbase can verify."}</p>
      </div>}
      <section className="approval-section">
        <div className="approval-section-intro">
          <strong>Collection</strong>
          <small>{request.collection_id
            ? `${request.application_name} requested this specific collection.`
            : `Choose where ${request.application_name} can work.`}</small>
        </div>
        <div className="approval-section-content">
          {compatible.length > 0 && <fieldset className="collection-choice-field">
            <legend>Collection and location</legend>
            <div className="collection-choice-list">
              {compatible.map(({ collection }) => {
                const provisions = neededProvisions(request, collection);
                return <label className={collection.id === collectionId ? "selected" : undefined} key={collection.id}>
                  <input
                    type="radio"
                    name={`collection-${request.id}`}
                    value={collection.id}
                    checked={collection.id === collectionId}
                    disabled={submitting !== null}
                    onChange={() => setCollectionId(collection.id)}
                  />
                  <span>
                    <strong>{collection.display_name}</strong>
                    <small>{collectionLocations.get(collection.id)}</small>
                  </span>
                  {provisions.length > 0 && <b>Setup needed</b>}
                </label>;
              })}
            </div>
          </fieldset>}
          {unavailable.length > 0 && <details className="collection-compatibility">
            <summary>{compatible.length > 0
              ? `${unavailable.length} other ${unavailable.length === 1 ? "collection is" : "collections are"} unavailable`
              : `${unavailable.length} ${unavailable.length === 1 ? "collection is" : "collections are"} unavailable`}</summary>
            <ul>{unavailable.map(({ collection, compatibility }) => <li key={collection.id}><span>{collection.display_name}</span><small>{compatibility.compatible ? "" : compatibility.detail}</small></li>)}</ul>
          </details>}
          {unavailableConnectors.length > 0 && <div className="field-note" role="status">
            {unavailableConnectors.map((connector) => connector.reason === "paused"
              ? `${connector.connector_name} has remote access paused.`
              : `${connector.connector_name} is offline.`).join(" ")} Those local collections cannot be selected until their computer is available.
          </div>}
          {request.requirements.collection_kind !== "hosted"
            && (compatible.length === 0 || unavailableConnectors.length > 0)
            && <div className="desktop-collection-option">
              <div>
                <strong>Use a folder on this computer</strong>
                <p>Open the desktop app to connect this computer, add a folder, and continue this same request.</p>
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
              <p>Creates a plain mdbase collection hosted by mdbase. Application access is still approved separately below.</p>
              <div>
                <button
                  className="quiet-action"
                  type="button"
                  disabled={submitting !== null}
                  onClick={() => {
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
            <div className="authorization-collection-action">
              {compatible.length === 0 && <p className="field-note">No compatible collection is ready.</p>}
              <button
                className="button secondary"
                type="button"
                aria-controls={`create-hosted-${request.id}`}
                disabled={submitting !== null}
                onClick={() => {
                  setCreatingHosted(true);
                  setError("");
                }}
              >Create hosted collection</button>
            </div>
          ))}
          {(!canCreateHosted || Boolean(request.collection_id)) && compatible.length === 0 && (
            <p className="field-note">
              {request.collection_id
                ? "The collection requested by this application is not available."
                : "No compatible collection is ready."}
            </p>
          )}
          {setup.length > 0 && <p className="field-note">{setupTypes.length > 0
            ? `Setup is required before access can become active. Add ${provisionNames(setup)}’s starter type below, or use an existing type.`
            : `Setup is required before access can become active. Add ${provisionNames(setup)}’s starter type.`}</p>}
        </div>
      </section>
      {setupContracts.length > 0 && <section className="approval-section contract-setup-section">
        <div className="approval-section-intro">
          <strong>Choose type setup</strong>
          <small>Add a starter type, or match meanings in one you already use. Nothing changes until you approve and the collection validates.</small>
        </div>
        <div className="approval-section-content contract-setup-list">
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
        </div>
      </section>}
      <section className="approval-section">
        <div className="approval-section-intro">
          <strong>Permissions</strong>
          <small>{permissionCount} specific actions across {permissionGroups.length} {permissionGroups.length === 1 ? "category" : "categories"}.</small>
        </div>
        <PermissionChoices
          groups={permissionGroups}
          selected={operations}
          disabled={submitting !== null}
          onToggle={toggleOperation}
        />
      </section>
      <NotificationAccess notifications={request.notifications} />
      {error && <div className="message error compact">{error}</div>}
      <footer className="approval-footer">
        <p>{selected
          ? `${request.application_name} will work in ${selected.display_name} at ${selected.connector_name}. You can revoke access at any time in mdbase connect.`
          : `Choose a compatible collection before allowing ${request.application_name}.`}</p>
        <div className="approval-actions">
          <button className="button secondary deny-button" type="button" disabled={submitting !== null} onClick={() => void decide("denied")}>{submitting === "denied" ? "Denying…" : "Deny"}</button>
          <button className="button primary" type="button" disabled={submitting !== null || !collectionId || selectedPermissionCount === 0 || !setupReady} onClick={() => void decide("approved")}>{submitting === "approved" ? (setup.length > 0 ? "Setting up and allowing…" : "Approving…") : setup.length > 0 ? `Set up and allow ${request.application_name}` : `Allow ${request.application_name}`}</button>
        </div>
      </footer>
    </div>
  );
}

function disambiguatedCollectionLocations(
  collections: AvailableCollection[]
): Map<string, string> {
  const groups = new Map<string, AvailableCollection[]>();
  for (const collection of collections) {
    const key = [
      collection.display_name.normalize("NFKC").toLocaleLowerCase(),
      collection.connector_name.normalize("NFKC").toLocaleLowerCase()
    ].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(collection);
    groups.set(key, group);
  }

  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    for (const collection of group) {
      labels.set(
        collection.id,
        group.length === 1
          ? collection.connector_name
          : `${collection.connector_name} · ID …${uniqueIdSuffix(
              collection.id,
              group.map((candidate) => candidate.id)
            )}`
      );
    }
  }
  return labels;
}

function uniqueIdSuffix(id: string, candidates: string[]): string {
  let length = Math.min(8, id.length);
  while (
    length < id.length &&
    candidates.some(
      (candidate) =>
        candidate !== id && candidate.slice(-length) === id.slice(-length)
    )
  ) {
    length += 1;
  }
  return id.slice(-length);
}

function PermissionChoices({
  groups,
  selected,
  disabled,
  onToggle
}: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(operation: string): void;
}) {
  const total = groups.reduce((count, group) => count + group.operations.length, 0);
  const selectedTotal = groups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => selected.has(operation.id)).length,
    0
  );
  const selectedGroups = groups.filter((group) =>
    group.operations.some((operation) => selected.has(operation.id))
  );
  return (
    <details className="permission-review">
      <summary>
        <span><strong>{selectedGroups.map((group) => group.label).join(" · ")}</strong><small>{selectedTotal} of {total} specific actions selected. Open details to narrow access.</small></span>
        <b>Details</b>
      </summary>
      <div className="permission-groups">{groups.map((group) => (
        <fieldset className="permission-group" key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div>{group.operations.map((operation) => (
            <label key={operation.id}>
              <input type="checkbox" checked={selected.has(operation.id)} onChange={() => onToggle(operation.id)} disabled={disabled} />
              <span>{operation.label}</span>
            </label>
          ))}</div>
        </fieldset>
      ))}</div>
    </details>
  );
}

function NotificationAccess({ notifications }: {
  notifications: PendingAuthorization["notifications"];
}) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-access">
      <summary>
        <span><strong>Change notifications</strong><small>{notifications.criteria.length} optional {notifications.criteria.length === 1 ? "rule" : "rules"}; pushes contain no record content.</small></span>
        <b>Details</b>
      </summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id} v{criterion.event.version}</code>
        </li>
      ))}</ul>
      <p>If you enable these in the application, the rules run inside the collection.</p>
    </details>
  );
}
