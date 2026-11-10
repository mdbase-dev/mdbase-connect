import { officialApps, withAppUrls } from "@mdbase-dev/ui/apps";
import { managedAppOrigins } from "../../../scripts/lib/managed-app-origins.mjs";
import { formatters } from "@mdbase-dev/i18n";
import { countLabel } from "./count-label";
import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { ConnectManagementClient, type ManagementOverview, type ManagementRequestOptions } from "@mdbase/connect-management";
import { groupApplicationAccess, authorizationOperationLabel, applicationAccessOriginLabel } from "@mdbase/connect-ui/access";
import { usePermissionSelection } from "@mdbase-dev/ui/permission-selection";
import { ConfirmAction } from "@mdbase/connect-ui/confirm-action";
import { ConnectPage as Page, ConnectSectionTitle as SectionTitle, ConnectEmpty as Empty, ListFilter } from "./ConnectPrimitives";
import { literal } from "./literal";
import { useState, type ReactNode } from "react";
import type { PerformOperation } from "./optimistic-action";

type Grant = ManagementOverview["grants"][number];
type Installation = NonNullable<ManagementOverview["installation_access"]>[number];
type BusyOperations = ReadonlySet<string>;
const allOperations = [
  "describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate",
  "create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source",
  "read_type", "create_type", "update_type", "apply_type_pack", "list_timers", "put_timer", "cancel_timer",
  "reconcile_timers"
];


export function applicationGroups(grants: Grant[], installations: Installation[]) {
  const groups = new Map(groupApplicationAccess(grants).map(group => [group.applicationId, { ...group, installations: [] as Installation[] }]));
  for (const entry of installations) {
    let group = groups.get(entry.application_family_id);
    if (!group) {
      group = { applicationId: entry.application_family_id, applicationName: entry.application_name, collectionCount: 0, grants: [], installations: [] };
      groups.set(group.applicationId, group);
    }
    group.installations.push(entry);
  }
  return [...groups.values()].map(group => ({
    ...group, collectionCount: new Set([...group.grants.map(g => g.collection_id), ...group.installations.flatMap(i => i.collection_id ? [i.collection_id] : [])]).size
  })).sort((a, b) => a.applicationName.localeCompare(b.applicationName));
}

function installationScopes(installations: Installation[]) {
  const scopes = new Map<string | null, Installation[]>();
  for (const entry of installations) {
    const entries = scopes.get(entry.collection_id) ?? [];
    entries.push(entry);
    scopes.set(entry.collection_id, entries);
  }
  return [...scopes].map(([collectionId, entries]) => ({ collectionId, entries }));
}

export async function revokeApplicationGroup(
  group: ReturnType<typeof applicationGroups>[number],
  client: ConnectManagementClient,
  collectionOnly: boolean,
  options: ManagementRequestOptions
): Promise<void> {
  if (collectionOnly) {
    for (const { collectionId, entries } of installationScopes(group.installations)) {
      if (collectionId) for (const applicationId of new Set(entries.map(entry => entry.application_id))) await client.removeInstallationAccess(applicationId, collectionId, options);
    }
  } else {
    for (const connector of new Set(group.installations.map(i => i.connector_id))) await client.revokeInstallation(connector, options);
  }
  if (group.grants.length) await client.revokeApplication(group.grants.map(g => g.id), options);
}

export function AppAccess({ error, groups, client, busy, perform, collectionName, editorOrigin, children }: {
  children?: ReactNode;
  groups: ReturnType<typeof applicationGroups>;
  client: ConnectManagementClient;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
  collectionName?: string;
  editorOrigin?: string;
}) {
  useLocaleRevision();
  const [query, setQuery] = useState("");
  const deployment = Object.values(managedAppOrigins).find(environment => environment.editorOrigin === editorOrigin);
  const visible = groups.filter(group => group.applicationName.toLocaleLowerCase(i18n.locale).includes(query.trim().toLocaleLowerCase(i18n.locale)));
  return <Page title={collectionName ? t(i18n)({ message: "Access", context: "Connect interface" }) : t(i18n)({ message: "Apps", context: "Connect interface" })} intro={collectionName ? t(i18n)`Review the access each app has to ${collectionName}.` : t(i18n)({ message: "Apps connected to your account. Your browser sign-in is never shared with them." })}>
    <section>{collectionName && <SectionTitle title={t(i18n)({ message: "Apps", context: "Connect interface" })} count={groups.length} />}
      {groups.length >= 10 && <ListFilter label={t(i18n)`Filter apps`} value={query} onChange={setQuery} />}
      {visible.map(group => <details className="mdbase-disclosure connect-application" key={group.applicationId} data-list-item data-command={`app:${group.applicationId}`}>
        <summary><span><strong>{group.applicationName}</strong>{!collectionName && <small>{countLabel(group.collectionCount, "collection")}</small>}</span></summary>
        <div className="connect-application-body">
          {installationScopes(group.installations).map(({ collectionId, entries }) => <div className="connect-grant connect-row" key={collectionId ?? "creation"}>
            <div>{!collectionName && <strong>{entries[0]!.collection_name ?? t(i18n)({ message: "No collection access", context: "Connect interface" })}</strong>}<small>{countLabel(entries.length, "installation")}</small>
              <details className="mdbase-disclosure connect-installation-details"><summary><Trans>Installation details</Trans></summary>
                {entries.map(entry => <div key={entry.connector_id}>
                  <small><Trans>{literal(entry.application_origin)} · {entry.device_kind === "mobile" ? t(i18n)({ message: "Mobile app", context: "Connect interface" }) : t(i18n)({ message: "App installation", context: "Connect interface" })}</Trans></small>
                  <small><Trans>Registered <time dateTime={entry.created_at}>{formatters(i18n.locale).date(new Date(entry.created_at), { dateStyle: "short", timeStyle: "short" })}</time></Trans></small>
                  <small>{entry.collection_id ? entry.available ? t(i18n)`Entire collection · Access as your account (${entry.role})` : t(i18n)({ message: "Previously approved · Collection no longer visible to your account" }) : t(i18n)({ message: "This installation has no approved collections." })}</small>
                  {entry.create_collections && <small><Trans>Can create collections for your account</Trans></small>}
                  {entry.approved_optional_file_actions.length > 0 && <small><Trans>Additional file actions approved: {entry.approved_optional_file_actions.join(", ")}</Trans></small>}
                </div>)}
              </details>
            </div>
            {collectionId && !collectionName && <ConfirmAction error={error} className="mdbase-button is-tertiary is-danger" label={t(i18n)({ message: "Revoke collection access", context: "Connect interface" })} question={t(i18n)`Revoke ${group.applicationName} access to ${entries[0]!.collection_name}?`} consequence={t(i18n)`New access will stop across all installations. Copies already downloaded cannot be removed remotely.`} pendingLabel={t(i18n)`Revoking access…`} confirmLabel={t(i18n)({ message: "Revoke collection access", context: "Connect interface" })} busy={busy.has(`scope-${group.applicationId}-${collectionId}`)} onConfirm={() => perform(`scope-${group.applicationId}-${collectionId}`, async options => {
              for (const applicationId of new Set(entries.map(entry => entry.application_id))) await client.removeInstallationAccess(applicationId, collectionId, options);
            }, false, undefined, t(i18n)`${group.applicationName} can no longer use ${entries[0]!.collection_name}`)} />}
          </div>)}
          {group.grants.map(grant => <GrantEditor error={error} key={grant.id} grant={grant} client={client} busy={busy} perform={perform} />)}
          <ConfirmAction error={error} className="mdbase-button is-danger connect-revoke-application" label={collectionName ? t(i18n)({ message: "Revoke access", context: "Connect interface" }) : t(i18n)({ message: "Revoke app", context: "Connect interface" })} question={collectionName ? t(i18n)`Revoke ${group.applicationName} access to ${collectionName}?` : t(i18n)`Revoke ${group.applicationName}?`} consequence={collectionName ? t(i18n)`New access will stop. Copies already downloaded by the app cannot be removed remotely.` : t(i18n)`New access and collection creation will stop across all installations. Copies already downloaded cannot be removed remotely.`} pendingLabel={t(i18n)`Revoking access…`} confirmLabel={collectionName ? t(i18n)({ message: "Revoke access", context: "Connect interface" }) : t(i18n)({ message: "Revoke app", context: "Connect interface" })} busy={busy.has(`application-${group.applicationId}`)} onConfirm={() => perform(`application-${group.applicationId}`, async options => {
            await revokeApplicationGroup(group, client, Boolean(collectionName), options);
          }, false, undefined, collectionName ? t(i18n)`${group.applicationName} can no longer use ${collectionName}` : t(i18n)`Revoked ${group.applicationName}`)} />
        </div>
      </details>)}
      {groups.length > 0 && visible.length === 0 && <Empty title={t(i18n)`No apps match`} body={t(i18n)`Try another app name.`} action={<button className="mdbase-button is-tertiary" onClick={() => setQuery("")}><Trans>Clear filter</Trans></button>} />}
      {groups.length === 0 && <Empty title={t(i18n)({ message: "No apps with access" })} body={t(i18n)({ message: "Apps appear here after you approve access." })} />}
    </section>
    {!collectionName && <section>
      <SectionTitle title={t(i18n)`Explore apps`} note={t(i18n)({ message: "Open an app, then choose which collections it can access." })} />
      <div className="connect-row-actions">
        {withAppUrls({
          editor: editorOrigin,
          reader: import.meta.env.VITE_MDBASE_READER_URL ?? deployment?.readerOrigin,
          writer: import.meta.env.VITE_MDBASE_WRITER_URL ?? deployment?.writerOrigin,
          journal: deployment?.journalOrigin,
          tasknotes: deployment?.tasknotesOrigin,
        }, officialApps).map(app => <a key={app.id} href={app.url}>{app.name}</a>)}
      </div>
    </section>}
    {children}
  </Page>;
}

function GrantEditor({ error, grant, client, busy, perform }: {
  client: ConnectManagementClient;
  grant: Grant;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const { selected, setSelected, needsReview, acknowledge } = usePermissionSelection(grant.id, grant.operations);
  const operations = new Set(selected);
  if (grant.revocation_status === "revoking") {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small><Trans>Revocation is pending. Waiting for {grant.collection_kind === "local" ? t(i18n)({ message: "the computer holding this collection" }) : t(i18n)({ message: "the hosted authority", context: "Connect interface" })} to confirm enforcement.</Trans></small></span><b>{t(i18n)({ message: "Revoking…", context: "Connect interface" })}</b></div>;
  }
  if (grant.scope.access !== "full_collection" || grant.scope.contracts.length > 0) {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small><Trans>Legacy scoped access is revoked. Reauthorize this app for the entire collection.</Trans></small></span><b>{t(i18n)({ message: "Reauthorization required", context: "Connect interface" })}</b></div>;
  }
  const ordered = [...allOperations.filter((operation) => grant.operations.includes(operation)), ...grant.operations.filter((operation) => !allOperations.includes(operation))];
  const changed = ordered.some((operation) => operations.has(operation) !== grant.operations.includes(operation));
  return <details className="mdbase-disclosure connect-grant">
    <summary><span><strong>{grant.collection_name}</strong><small>{plural(grant.operations.length, { one: "# permission", other: "# permissions" })} · {applicationAccessOriginLabel(grant.application_origin)}</small></span><b>{t(i18n)({ message: "Permissions", context: "Connect interface" })}</b></summary>
    <div className="connect-grant-body">
      {needsReview && <p role="status"><Trans>Access changed elsewhere. Review the current permissions before saving. <button className="mdbase-button is-tertiary" onClick={acknowledge}>Review current access</button></Trans></p>}
      <div className="connect-permissions">{ordered.map((operation) => <label key={operation}><input className="mdbase-checkbox" type="checkbox" checked={operations.has(operation)} onChange={() => setSelected((current) => current.includes(operation)
        ? current.filter((value) => value !== operation) : [...current, operation])} /><span>{authorizationOperationLabel(operation)}</span></label>)}</div>
      <div className="connect-grant-meta"><span><Trans>Collection ID</Trans></span><strong>{grant.collection_id}</strong><span><Trans>Scope</Trans></span><strong><Trans>Entire collection</Trans></strong><span><Trans>Origin</Trans></span><strong>{grant.application_origin}</strong></div>
      <div className="connect-row-actions"><button className="connect-primary-action mdbase-button is-primary" disabled={needsReview || !changed || operations.size === 0 || busy.has(`grant-${grant.id}`)} onClick={() => void perform(`grant-${grant.id}`, (options) => client.updateGrant(grant.id, ordered.filter((operation) => operations.has(operation)), options), false, undefined, t(i18n)`Updated ${grant.application_name} access to ${grant.collection_name}`)}><Trans>Save narrower access</Trans></button><ConfirmAction error={error} className="mdbase-button is-tertiary is-danger" label={t(i18n)({ message: "Revoke", context: "Connect interface" })} question={t(i18n)`Revoke access to ${grant.collection_name}?`} consequence={t(i18n)`New access will stop. Copies already downloaded by the app cannot be removed remotely.`} pendingLabel={t(i18n)`Revoking access…`} confirmLabel={t(i18n)({ message: "Revoke", context: "Connect interface" })} busy={busy.has(`grant-${grant.id}`)} onConfirm={() => perform(`grant-${grant.id}`, (options) => client.revokeGrant(grant.id, options), false, undefined, t(i18n)`${grant.application_name} can no longer use ${grant.collection_name}`)} /></div>
    </div>
  </details>;
}

