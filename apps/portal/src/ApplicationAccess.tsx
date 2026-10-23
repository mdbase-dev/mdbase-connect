import { formatters } from "@mdbase-dev/i18n";
import { countLabel } from "./count-label";
import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { ConnectManagementClient, type ManagementOverview, type ManagementRequestOptions } from "@mdbase/connect-management";
import { groupApplicationAccess, authorizationOperationLabel, applicationAccessOriginLabel } from "@mdbase/connect-ui/access";
import { usePermissionSelection } from "@mdbase-dev/ui/permission-selection";
import { ConfirmAction, ConnectPage as Page, ConnectSectionTitle as SectionTitle, ConnectEmpty as Empty } from "./ConnectPrimitives";

type Grant = ManagementOverview["grants"][number];
type Installation = NonNullable<ManagementOverview["installation_access"]>[number];
type BusyOperations = ReadonlySet<string>;
type PerformOperation = (id: string, action: (options: ManagementRequestOptions) => Promise<void>) => Promise<boolean>;
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

export function AppAccess({ groups, client, busy, perform, collectionName }: {
  groups: ReturnType<typeof applicationGroups>;
  client: ConnectManagementClient;
  busy: BusyOperations;
  perform: PerformOperation;
  collectionName?: string;
}) {
  useLocaleRevision();
  return <Page title={collectionName ? t(i18n)({ message: "Application access", context: "Connect interface" }) : t(i18n)({ message: "Applications", context: "Connect interface" })} intro={collectionName ? t(i18n)`Review the access each application has to ${collectionName}.` : t(i18n)({ message: "Review applications connected to your account. Your browser sign-in is never shared with them." })}>
    <section><SectionTitle title={collectionName ? t(i18n)({ message: "Connected applications", context: "Connect interface" }) : t(i18n)({ message: "Application access", context: "Connect interface" })} count={groups.length} />
      {groups.map(group => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{countLabel(group.collectionCount, "collection")}</small></span><b>{t(i18n)({ message: "Review", context: "Connect interface" })}</b></summary>
        <div className="connect-application-body">
          {installationScopes(group.installations).map(({ collectionId, entries }) => <div className="connect-grant connect-row" key={collectionId ?? "creation"}>
            <div><strong>{entries[0]!.collection_name ?? t(i18n)({ message: "No collection access", context: "Connect interface" })}</strong><small>{countLabel(entries.length, "installation")}</small>
              <details className="connect-installation-details"><summary><Trans>Installation details</Trans></summary>
                {entries.map(entry => <div key={entry.connector_id}>
                  <small><Trans>{entry.application_origin} · {entry.device_kind === "mobile" ? t(i18n)({ message: "Mobile app", context: "Connect interface" }) : t(i18n)({ message: "App installation", context: "Connect interface" })} · ID {entry.installation_id.slice(-8)}</Trans></small>
                  <small><Trans>Registered <time dateTime={entry.created_at}>{formatters(i18n.locale).date(new Date(entry.created_at), { dateStyle: "medium", timeStyle: "short" })}</time></Trans></small>
                  <small>{entry.collection_id ? entry.available ? t(i18n)`Entire collection · Access as your account (${entry.role})` : t(i18n)({ message: "Previously approved · Collection no longer visible to your account" }) : t(i18n)({ message: "This installation has no approved collections." })}</small>
                  {entry.create_collections && <small><Trans>Can create collections for your account</Trans></small>}
                  {entry.approved_optional_file_actions.length > 0 && <small><Trans>Additional file actions approved: {entry.approved_optional_file_actions.join(", ")}</Trans></small>}
                </div>)}
              </details>
            </div>
            {collectionId && <ConfirmAction className="danger" label={t(i18n)({ message: "Revoke collection access", context: "Connect interface" })} question={t(i18n)`Revoke ${group.applicationName} access to ${entries[0]!.collection_name} across all its installations?`} confirmLabel={t(i18n)({ message: "Revoke collection access", context: "Connect interface" })} busy={busy.has(`scope-${group.applicationId}-${collectionId}`)} onConfirm={() => void perform(`scope-${group.applicationId}-${collectionId}`, async options => {
              for (const applicationId of new Set(entries.map(entry => entry.application_id))) await client.removeInstallationAccess(applicationId, collectionId, options);
            })} />}
          </div>)}
          {group.grants.map(grant => <GrantEditor key={grant.id} grant={grant} client={client} busy={busy} perform={perform} />)}
          <ConfirmAction className="danger connect-revoke-application" label={collectionName ? t(i18n)({ message: "Revoke access", context: "Connect interface" }) : t(i18n)({ message: "Revoke application", context: "Connect interface" })} question={collectionName ? t(i18n)`Revoke ${group.applicationName} access to ${collectionName}?` : t(i18n)`Revoke all ${group.applicationName} access and collection creation permission?`} confirmLabel={collectionName ? t(i18n)({ message: "Revoke access", context: "Connect interface" }) : t(i18n)({ message: "Revoke application", context: "Connect interface" })} busy={busy.has(`application-${group.applicationId}`)} onConfirm={() => void perform(`application-${group.applicationId}`, async options => {
            if (collectionName) {
              for (const { collectionId, entries } of installationScopes(group.installations)) {
                if (collectionId) for (const applicationId of new Set(entries.map(entry => entry.application_id))) await client.removeInstallationAccess(applicationId, collectionId, options);
              }
            } else {
              for (const connector of new Set(group.installations.map(i => i.connector_id))) await client.revokeInstallation(connector, options);
            }
            if (group.grants.length) await client.revokeApplication(group.grants.map(g => g.id), options);
          })} />
        </div>
      </details>)}
      {groups.length === 0 && <Empty title={t(i18n)({ message: "No connected applications" })} body={t(i18n)({ message: "Applications appear here after you approve access." })} />}
    </section>
  </Page>;
}

function GrantEditor({ grant, client, busy, perform }: {
  client: ConnectManagementClient;
  grant: Grant;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const { selected, setSelected, needsReview, acknowledge } = usePermissionSelection(grant.id, grant.operations);
  const operations = new Set(selected);
  if (grant.revocation_status === "revoking") {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small><Trans>Revocation is pending. Waiting for {grant.collection_kind === "local" ? t(i18n)({ message: "the computer holding this collection" }) : t(i18n)({ message: "the hosted authority", context: "Connect interface" })} to confirm enforcement.</Trans></small></span><b>{t(i18n)({ message: "Revoking…", context: "Connect interface" })}</b></div>;
  }
  if (grant.scope.access !== "full_collection" || grant.scope.contracts.length > 0) {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small><Trans>Legacy scoped access is revoked. Reauthorize this application for the entire collection.</Trans></small></span><b>{t(i18n)({ message: "Reauthorization required", context: "Connect interface" })}</b></div>;
  }
  const ordered = [...allOperations.filter((operation) => grant.operations.includes(operation)), ...grant.operations.filter((operation) => !allOperations.includes(operation))];
  const changed = ordered.some((operation) => operations.has(operation) !== grant.operations.includes(operation));
  return <details className="connect-grant">
    <summary><span><strong>{grant.collection_name}</strong><small><Trans>{plural(grant.operations.length, { one: "# permission", other: "# permissions" })} · {applicationAccessOriginLabel(grant.application_origin)}</Trans></small></span><b>{t(i18n)({ message: "Permissions", context: "Connect interface" })}</b></summary>
    <div className="connect-grant-body">
      {needsReview && <p role="status"><Trans>Access changed elsewhere. Review the current permissions before saving. <button onClick={acknowledge}>Review current access</button></Trans></p>}
      <div className="connect-permissions">{ordered.map((operation) => <label key={operation}><input className="mdbase-checkbox" type="checkbox" checked={operations.has(operation)} onChange={() => setSelected((current) => current.includes(operation)
        ? current.filter((value) => value !== operation) : [...current, operation])} /><span>{authorizationOperationLabel(operation)}</span></label>)}</div>
      <div className="connect-grant-meta"><span><Trans>Collection ID</Trans></span><strong>{grant.collection_id}</strong><span><Trans>Scope</Trans></span><strong><Trans>Entire collection</Trans></strong><span><Trans>Origin</Trans></span><strong>{grant.application_origin}</strong></div>
      <div className="connect-row-actions"><button className="connect-primary-action mdbase-button is-primary" disabled={needsReview || !changed || operations.size === 0 || busy.has(`grant-${grant.id}`)} onClick={() => void perform(`grant-${grant.id}`, (options) => client.updateGrant(grant.id, ordered.filter((operation) => operations.has(operation)), options))}><Trans>Save narrower access</Trans></button><ConfirmAction className="danger" label={t(i18n)({ message: "Revoke", context: "Connect interface" })} question={t(i18n)`Revoke access to ${grant.collection_name}?`} confirmLabel={t(i18n)({ message: "Revoke", context: "Connect interface" })} busy={busy.has(`grant-${grant.id}`)} onConfirm={() => void perform(`grant-${grant.id}`, (options) => client.revokeGrant(grant.id, options))} /></div>
    </div>
  </details>;
}

