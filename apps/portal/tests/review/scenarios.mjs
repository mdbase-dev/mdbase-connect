export const clock = "2026-11-05T00:00:00.000Z";
export const expires = "2026-12-05T00:00:00.000Z";
export const pairingId = "00000000-0000-4000-8000-000000000001";
export const authorizationId = "00000000-0000-4000-8000-000000000002";
const user = { id: "maya", name: "Maya Chen", email: "maya@chen.example", login: "mayachen" };
export const authentication = {
  provider: "session", registration: "open", password_login: true,
  password_recovery: true, password_public_registration: true, external_public_registration: true,
  providers: [
    { id: "google", label: "Continue with Google", login_url: "/auth/google" },
    { id: "github", label: "Continue with GitHub", login_url: "/auth/github" }
  ],
  agreements: { terms: { version: "1", url: "/__review/terms" }, privacy: { version: "1", url: "/__review/privacy" } }
};

/** @returns {import('@mdbase/connect-management').HostedCollection} */
export function hostedCollection(id, displayName) {
  return {
    id, display_name: displayName, template: "mdbase", provider_url: "http://127.0.0.1:4801",
    spec_version: "0.3.0", contracts: [], authority_state: "active", authority_epoch: 1,
    transferred_collection_id: null, created_at: clock,
    access: { relationship: "owner", role: "owner", can_authorize_applications: true,
      can_manage_collection: true, can_rename_collection: true, can_delete_collection: true, can_manage_members: true },
    replicas: [{ id: `replica-${id}`, name: "Studio Markdown folder", mode: "read_write", allowed_types: [],
      revoked_at: null, revocation_status: "active", created_at: clock,
      sync_status: { head: 248, acknowledged_sequence: 248, last_seen_at: clock, token_expires_at: expires } }]
  };
}

/** @returns {import('@mdbase/connect-management').ManagementOverview} */
function overview(count) {
  const names = ["Field research", "Garden journal", "Reading notes", "Household projects", "Coastal restoration", "Workshop recipes", "Travel journal"];
  const connectors = ["Studio MacBook", "Home workstation", "Travel laptop"].map((name, index) => ({
    id: `computer-${index}`, name, last_seen_at: index === 2 ? "2026-10-30T08:20:00.000Z" : clock,
    created_at: "2026-09-12T08:20:00.000Z", connector_version: "0.1.0-beta.152", compatibility: "compatible"
  }));
  const collections = Array.from({ length: count }, (_, index) => ({
    id: `collection-${index}`, display_name: count > 60
      ? `${names[index % names.length]} — ${["North coast", "Southern wetlands", "Community nursery"][index % 3]} research archive, season ${2020 + index}`
      : names[index % names.length],
    connector_id: connectors[index % 3].id, connector_name: connectors[index % 3].name,
    local_id: `local-${index}`, spec_version: "0.3.0", enabled: true, contracts: [], last_seen_at: connectors[index % 3].last_seen_at
  }));
  const hosted = count > 1 ? [hostedCollection("hosted-0", "Shared research library"), hostedCollection("hosted-1", "Coastal survey team")] : [];
  const all = [...collections, ...hosted];
  return {
    user: { ...user }, subscription: null, hosted_collections_available: true,
    collection_creation_available: true, collection_sharing_available: true,
    authentication: { provider: "password", registration: "open" },
    connectors: count ? connectors : [], collections, hosted_collections: hosted,
    grants: count > 1 ? all.flatMap((collection, index) => (count > 60 ? [0, 1, 2, 3] : [index % 4]).map(app => ({
      id: `grant-${index}-${app}`, operations: app === 1 ? ["read"] : ["read", "query", "create", "update"],
      scope: { contracts: [], access: "full_collection" }, created_at: clock, revoked_at: null,
      revocation_status: "active", reauthorization_required_at: null, reauthorization_reason: null,
      collection_id: collection.id, collection_name: collection.display_name,
      collection_kind: collection.id.startsWith("hosted") ? "hosted" : "local",
      application_id: `app-${app}`, application_family_id: `app-${app}`,
      application_name: ["TaskNotes", "Reader", "Writer", "Research index"][app], distribution: "web",
      homepage: `https://${["tasknotes", "reader", "writer", "research"][app]}.mdbase.dev`,
      application_origin: `https://${["tasknotes", "reader", "writer", "research"][app]}.mdbase.dev`, project_url: null, icon: null
    }))) : [],
    pending_authorizations: count > 1 ? [{ id: authorizationId, flow: "authorization_code", requested_operations: ["read", "create", "update"],
      expires_at: expires, application_id: "app-0", application_name: "TaskNotes", distribution: "web",
      homepage: "https://tasknotes.mdbase.dev", project_url: null, icon: null }] : []
  };
}

/** @returns {import('@mdbase/connect-management').AccountData} */
export function account(overview) {
  const count = overview.hosted_collections.length;
  return {
    backend: "legacy", user: overview.user,
    authentication: { managed: true, current_provider: "password", available_providers: { github: true, google: true, password: true },
      identities: [{ provider: "github", subject: "maya-github", login: "mayachen", email: user.email,
        email_verified: true, linked_at: clock, current: false, removable: true }],
      password: { configured: true, email: user.email, current: true, change_available: true } },
    storage: { status: "available", total_content_bytes: count * 3145728, total_file_bytes: count * 20971520,
      total_storage_bytes: count * 24117248, total_stored_file_bytes: count * 25165824, total_records: count * 937,
      collections: overview.hosted_collections.map(collection => ({ id: collection.id, display_name: collection.display_name,
        usage: { collection_id: collection.id, record_count: 937, content_bytes: 3145728, max_records: 100000,
          max_content_bytes: 1073741824, max_document_bytes: 2097152, file_count: 43, file_bytes: 20971520,
          stored_file_bytes: 25165824, max_files: 10000, max_file_bytes: 1073741824,
          max_stored_file_bytes: 2147483648, max_single_file_bytes: 262144000 } })) },
    email_preferences: { announcements: true, product_updates: false },
    deletion: { available: true, unavailable_reason: null, owned_collections: overview.collections.length + overview.hosted_collections.length,
      hosted_collections: overview.hosted_collections.length, local_collections: overview.collections.length,
      computers: overview.connectors.length, development_confirmation: true }
  };
}

function state(count = 5) {
  const data = overview(count);
  return {
    signedIn: true, overview: data, account: account(data),
    sessions: ["Studio Chrome", "Home Firefox", "Travel Safari"].map((client_name, index) => ({
      id: `session-${index}`, provider: "password", client_name, created_at: clock,
      last_seen_at: index === 2 ? "2026-10-30T08:20:00.000Z" : clock, expires_at: expires, current: index === 0
    })),
    members: Object.fromEntries(data.hosted_collections.map(collection => [collection.id, [
      { kind: "owner", name: user.name, role: "owner", state: "active", accepted_at: clock },
      { kind: "member", id: "member-sam", name: "Sam Okafor", role: "editor", state: "active", accepted_at: clock },
      { kind: "member", id: "member-elena", name: "Elena Rossi", role: "viewer", state: "active", accepted_at: clock }
    ]])),
    invitations: {}, onboarding: "ready", authorizationStatus: "pending",
    authorization: {
      ...data.pending_authorizations[0], id: authorizationId, application_name: "TaskNotes", application_id: "app-0",
      flow: "authorization_code", requested_operations: ["read", "query", "create", "update"], expires_at: expires,
      distribution: "web", homepage: "https://tasknotes.mdbase.dev", application_origin: "https://tasknotes.mdbase.dev", project_url: null, icon: null,
      requirements: { contracts: [], capabilities: { contract_version: 2, required: ["collection.read", "records.create", "records.edit"], optional: ["records.delete"] }, access: "full_collection" },
      provisions: { type_packs: [] }, notifications: { criteria: [] }
    },
    pairing: {
      connector_name: "Reader", approved_at: null, installation_device: true, kind: "app-runtime",
      account_selection_confirmed: true, attested: true, fingerprint: "8b73-c91e-24af-60d2", account_email: user.email, signed_in_account_email: user.email,
      app_origin: "https://reader.mdbase.dev", expires_at: expires, can_create_collection: true,
      collections: data.collections.map(collection => ({ collection_id: collection.id, display_name: collection.display_name, role: "owner" }))
    }
  };
}

const pair = `/pair/${pairingId}`;
const consent = `/authorize/${authorizationId}`;
const definitions = [
  ["anonymous", "/login", "Sign in", 0, state => { state.signedIn = false; }],
  ["signup", "/signup", "Create an account", 0, state => { state.signedIn = false; }],
  ["signup-agreements", "/signup#verification=review-email", "Create an account", 0, state => { state.signedIn = false; }],
  ["forgot-password", "/forgot-password", "Reset your password", 0, state => { state.signedIn = false; }],
  ["onboarding-pending", "/getting-started", "Creating your first collection", 0, state => { state.onboarding = "pending"; }],
  ["onboarding-failed", "/getting-started", "We couldn't create your collection", 0, state => { state.onboarding = "failed"; }],
  ["empty-account", "/collections", "No collections", 0],
  ["single-collection", "/?collection=collection-0", "Field research", 1],
  ["typical-account", "/collections", "Collections", 5],
  ["heavy-account", "/collections", "Collections", 64],
  ["pairing-fresh", pair, "Open in Reader", 5, state => { state.pairing.account_selection_confirmed = false; }],
  ["pairing-many", pair, "Open in Reader", 64],
  ["pairing-create-new", pair, "Collection name", 0, state => { state.pairing.creation = { collection_id: "creation-reader", display_name: "Reader highlights", completed: false }; }],
  ["pairing-upgrade", pair, "Account upgrade needed", 5, state => { state.pairing.account_selection_confirmed = false; state.pairing.account_upgrade = "not_scheduled"; }],
  ["pairing-signed-out", pair, "Sign in", 5, state => { state.signedIn = false; }],
  ["authorization", consent, "TaskNotes", 5],
  ["authorization-review", consent, "Allow access", 1],
  ["authorization-required", consent, "All permissions listed below are required", 1, state => { state.authorization.requirements.capabilities.optional = []; }],
  ["authorization-approved", consent, "TaskNotes can now use Field research", 5, state => { state.authorizationStatus = "approved"; state.authorization.collection_id = "collection-0"; state.overview.pending_authorizations = []; }],
  ["authorization-denied", consent, "Access denied", 5, state => { state.authorizationStatus = "denied"; state.overview.pending_authorizations = []; }],
  ["collection-overview", "/?collection=hosted-0", "Shared research library", 5],
  ["collection-storage", "/storage?collection=hosted-0", "Storage & sync", 5],
  ["collection-access", "/access?collection=hosted-0", "Sam Okafor", 5],
  ["applications", "/applications", "Applications", 5],
  ["computers", "/computers", "Computers", 5],
  ["account-sessions", "/account", "Travel Safari", 5],
  ["feedback", "/feedback", "Send feedback", 5],
  ["computer-offline", "/storage?collection=collection-2", "Storage & sync", 5],
  ["sync-conflict", "/access?collection=hosted-0", "Sync conflict: reconcile the Studio and Travel replicas before changing access.", 5],
  ["revoking", "/storage?collection=hosted-0", "Disconnecting…", 5, state => { state.overview.hosted_collections[0].replicas[0].revocation_status = "revoking"; state.overview.grants[0].revocation_status = "revoking"; }],
  ["provider-unavailable", "/access?collection=hosted-0", "The hosted provider is unavailable. Try again shortly.", 5],
  ["server-500", "/collections", "The review server could not load your account. Try again.", 5],
  ["session-expired", "/account", "Sign in", 5, state => { state.signedIn = false; }]
];

export const scenarios = definitions.map(([name, path, ready, count, change]) => {
  const initial = state(count);
  change?.(initial);
  return { name, path, ready, state: initial };
});
