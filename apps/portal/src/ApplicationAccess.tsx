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
  return <Page title={collectionName ? "Application access" : "Applications"} intro={collectionName ? `Review the access each application has to ${collectionName}.` : "Review applications connected to your account. Your browser sign-in is never shared with them."}>
    <section><SectionTitle title={collectionName ? "Connected applications" : "Application access"} count={groups.length} />
      {groups.map(group => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{group.collectionCount} {group.collectionCount === 1 ? "collection" : "collections"}</small></span><b>Review</b></summary>
        <div className="connect-application-body">
          {installationScopes(group.installations).map(({ collectionId, entries }) => <div className="connect-grant connect-row" key={collectionId ?? "creation"}>
            <div><strong>{entries[0]!.collection_name ?? "No collection access"}</strong><small>{entries.length} {entries.length === 1 ? "installation" : "installations"}</small>
              <details className="connect-installation-details"><summary>Installation details</summary>
                {entries.map(entry => <div key={entry.connector_id}>
                  <small>{entry.application_origin} · {entry.device_kind === "mobile" ? "Mobile app" : "App installation"} · ID {entry.installation_id.slice(-8)}</small>
                  <small>Registered <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time></small>
                  <small>{entry.collection_id ? entry.available ? `Entire collection · Access as your account (${entry.role})` : "Previously approved · Collection no longer visible to your account" : "This installation has no approved collections."}</small>
                  {entry.create_collections && <small>Can create collections for your account</small>}
                  {entry.approved_optional_file_actions.length > 0 && <small>Additional file actions approved: {entry.approved_optional_file_actions.join(", ")}</small>}
                </div>)}
              </details>
            </div>
            {collectionId && <ConfirmAction className="danger" label="Revoke collection access" question={`Revoke ${group.applicationName} access to ${entries[0]!.collection_name} across all its installations?`} confirmLabel="Revoke collection access" busy={busy.has(`scope-${group.applicationId}-${collectionId}`)} onConfirm={() => void perform(`scope-${group.applicationId}-${collectionId}`, async options => {
              for (const applicationId of new Set(entries.map(entry => entry.application_id))) await client.removeInstallationAccess(applicationId, collectionId, options);
            })} />}
          </div>)}
          {group.grants.map(grant => <GrantEditor key={grant.id} grant={grant} client={client} busy={busy} perform={perform} />)}
          <ConfirmAction className="danger connect-revoke-application" label={collectionName ? "Revoke access" : "Revoke application"} question={collectionName ? `Revoke ${group.applicationName} access to ${collectionName}?` : `Revoke all ${group.applicationName} access and collection creation permission?`} confirmLabel={collectionName ? "Revoke access" : "Revoke application"} busy={busy.has(`application-${group.applicationId}`)} onConfirm={() => void perform(`application-${group.applicationId}`, async options => {
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
      {groups.length === 0 && <Empty title="No connected applications" body="Applications appear here after you approve access." />}
    </section>
  </Page>;
}

function GrantEditor({ grant, client, busy, perform }: {
  client: ConnectManagementClient;
  grant: Grant;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  const { selected, setSelected, needsReview, acknowledge } = usePermissionSelection(grant.id, grant.operations);
  const operations = new Set(selected);
  if (grant.revocation_status === "revoking") {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small>Revocation is pending. Waiting for {grant.collection_kind === "local" ? "the computer holding this collection" : "the hosted authority"} to confirm enforcement.</small></span><b>Revoking…</b></div>;
  }
  if (grant.scope.access !== "full_collection" || grant.scope.contracts.length > 0) {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small>Legacy scoped access is revoked. Reauthorize this application for the entire collection.</small></span><b>Reauthorization required</b></div>;
  }
  const ordered = [...allOperations.filter((operation) => grant.operations.includes(operation)), ...grant.operations.filter((operation) => !allOperations.includes(operation))];
  const changed = ordered.some((operation) => operations.has(operation) !== grant.operations.includes(operation));
  return <details className="connect-grant">
    <summary><span><strong>{grant.collection_name}</strong><small>{grant.operations.length} permissions · {applicationAccessOriginLabel(grant.application_origin)}</small></span><b>Permissions</b></summary>
    <div className="connect-grant-body">
      {needsReview && <p role="status">Access changed elsewhere. Review the current permissions before saving. <button onClick={acknowledge}>Review current access</button></p>}
      <div className="connect-permissions">{ordered.map((operation) => <label key={operation}><input className="mdbase-checkbox" type="checkbox" checked={operations.has(operation)} onChange={() => setSelected((current) => current.includes(operation)
        ? current.filter((value) => value !== operation) : [...current, operation])} /><span>{authorizationOperationLabel(operation)}</span></label>)}</div>
      <div className="connect-grant-meta"><span>Collection ID</span><strong>{grant.collection_id}</strong><span>Scope</span><strong>Entire collection</strong><span>Origin</span><strong>{grant.application_origin}</strong></div>
      <div className="connect-row-actions"><button className="connect-primary-action mdbase-button is-primary" disabled={needsReview || !changed || operations.size === 0 || busy.has(`grant-${grant.id}`)} onClick={() => void perform(`grant-${grant.id}`, (options) => client.updateGrant(grant.id, ordered.filter((operation) => operations.has(operation)), options))}>Save narrower access</button><ConfirmAction className="danger" label="Revoke" question={`Revoke access to ${grant.collection_name}?`} confirmLabel="Revoke" busy={busy.has(`grant-${grant.id}`)} onConfirm={() => void perform(`grant-${grant.id}`, (options) => client.revokeGrant(grant.id, options))} /></div>
    </div>
  </details>;
}

