# Portable people and app-visible account identity

Status: implemented on coordinated `feature/portable-people` branches; not
published or deployed. Connect provides app-consented identity/member endpoints,
SDK discovery, and guided person creation/linking in collection settings.
TaskNotes provides person-ID assignment editing and an Assigned to me search
filter through its repository. No existing grant acquires identity access.

Companion candidates: `mdbase.person` 1.0.0 in Contact pack 1.1.0;
`tasknotes.task` rc.4 in TaskNotes pack rc.13 (task type v2); `tasknotes-model`
rc.12 and `tasknotes-spec` rc.4. Existing published versions are unchanged.
Catalog publication and coordinated server/client rollout still require review.

## Verification

- Complete Connect JavaScript and Rust workspace tests and type/architecture checks.
- Real isolated local daemon, signed consent/grant, browser and SDK end-to-end
  suite, including owner identity/directory discovery while record routing is direct.
- Server denial, expiry, revoked/suspended/unbound membership and manifest-binding tests.
- Editor mapped linking, reviewed Contact-only conversion, readonly and duplicate tests.
- Catalog validation plus real Contact pack install/upgrade, single-contact
  conversion, stable ID/body preservation and stale revision refusal.
- TaskNotes unit/repository/UI tests, lint, typecheck, conformance and production build;
  model tests cover custom assignment mappings, clearing and recurrence inheritance.

The SDK build emits non-blocking gzip-size review warnings against its checked-in
baseline; no size limits were raised. LAB and production have not been deployed
or exercised for this initiative. Hosted profile routes have repository-level
coverage, not a new live hosted-provider acceptance run.

## Decisions

- A person is an ordinary record implementing `mdbase.person`, with a stable
  `id`, collection-owned `name`, and optional `identities` array.
- Each identity has an issuer URL and opaque, account-wide subject. Both are
  matched exactly. Portability is preferred to collection-scoped pseudonyms.
- The association lives in editable frontmatter, not a Connect binding table.
- Connect supplies authenticated account identity and current membership;
  person records never authenticate a caller or grant access.
- Task assignments reference the person ID, not the account subject, file path,
  email, display name, or membership ID.
- Reuse `mdbase.contact` for contact semantics rather than duplicating its
  address-book fields. The new Person starter implements both contracts.

Example collection data:

```yaml
type: person
id: person_2c1343ec-cac1-4d58-98c9-41736f4de7db
name: Callum
identities:
  - issuer: https://connect.example
    subject: usr_789
```

The actual issuer and subject must be copied from Connect, not constructed by
an app. They are identifiers, never credentials. Installing a person type pack
is passive and does not authorize identity disclosure or invite anyone.

## Responsibility boundaries

### Collection engine

Ordinary reads, contract projections, queries, validation, and writes. No
Connect account lookup, special authentication fields, or security authority
is added to mdbase-rs. Local custom types implement the canonical contract via
normal field mappings. No fixed `people/` directory is required.

### Connect

Expose a minimal authenticated-current-account identity and a collection member
directory through application authorization, not account-management cookies.
These are control-plane metadata, not decrypted collection records.

Identity discovery can use the control plane for both hosted and relay
collections. A local connector does not need to verify person frontmatter or
hold an identity-binding database. Direct collection access can remain available
when identity discovery is unavailable; the app must not misrepresent failed
identity discovery as "no linked person".

Current local access is owner-only. A local member directory can describe that
owner, but this feature must not imply that shared relay membership exists.

### Consuming apps

Query person contract projections through their normal provider-neutral
repository. Resolve authenticated identity against the complete set of person
records. Use the resulting person ID for assignments and "Assigned to me".
Linking a record to the current account is an ordinary optimistic-concurrency
record update; unlinked contacts remain valid and useful without an account.

## Identity and privacy invariants

The issuer is a stable deployment identity, not a hosted provider URL, current
relay route, authority URL, or a value inferred from an untrusted Host header.
Its production value and migration rules must be explicit before issuance.

The account subject must not be an email, external OAuth provider subject,
membership ID, or recycled identifier. It remains stable across collections,
renames, email changes, provider linking, and removal/rejoining. Recreating a
deleted account gets a new subject. An existing random internal account UUID
may be suitable, but exposing it is a deliberate public identifier decision,
not an incidental database serialization.

Account-wide identifiers permit correlation across collections. Consent must
say this plainly. The directory exposes only identity, display name, role, and
current availability to collaborators. Do not expose emails, submitted
invitation addresses, invitation tokens, pending invitations, or unrelated
accounts. Display names are not unique and never resolve identity.

## Authorization implementation boundary

Connect's existing v2 capability groups are generated and bind exact collection
operations across TypeScript and Rust. Identity and membership discovery are
not existing collection operations. Do not silently add them to
`collection.read`, append identity fields to every token response, expose the
owner-only management directory to apps, or treat an empty operation group as
proof of consent.

Version 1 is deliberately required-only consent in the exact application manifest:

```json
{"requirements":{"people":{"version":1,"permissions":["identity","members"]}}}
```

The existing signed binding already includes the exact manifest digest. The
immutable application declaration therefore persists this required consent;
there is no parallel binding database, new collection operation, or new mutable
grant flag. Changing people permissions changes application identity and needs
fresh approval. Removing people access alone means authorizing a declaration
without it; the initial version does not offer optional permission toggles.
Legacy declarations reject this field. Older servers reject the new manifest;
older grants have no people requirement and the new endpoints deny them.

`GET /v1/authorities/:collectionId/identity` returns `{issuer, subject, name}`.
`GET /v1/authorities/:collectionId/members` returns `{members: [...]}`, adding
`role` to each profile. Both use the control-plane application access token,
including for hosted collections. The issuer is the configured public URL with
its final slash removed; subject is the existing random internal account UUID,
now deliberately an account-wide public identifier. Changing the configured
issuer is an identity migration, not a transparent routing change.

The SDK exposes `connection.people.current()` and `connection.people.members()`
with typed outcomes, cancellation and bounded requests. A missing endpoint is
`unsupported_operation`; denied consent is `access_denied`; availability failures
are not empty directories. The editor uses normal collection grants to create
records or append an identity to an existing Person-compatible record.
An existing Contact-only note can be explicitly converted to an installed type
implementing both Person and Contact. The user reviews the changed fields before
a revision-guarded update to that one note; its path, contact semantics, body,
extra fields, and existing target ID are retained. Non-individual contacts and
ambiguous implementations are not conversion candidates. Targets must preserve
all populated canonical Contact fields. Schema validation may require further
manual edits for custom types. Alternatively, users can configure Person mappings
on their existing type in Types. Neither route silently migrates an address book.

Review this implementation together with:

1. Manifest parsing, canonical application identity, and approval binding.
2. Concrete consent copy, optional/required selection, and grant persistence.
3. Refresh, narrowing, revocation, and old-server/SDK compatibility.
4. Capability-aware endpoints and typed SDK outcomes.

Old grants retain their exact authority and disclose no newly introduced
identity metadata. Unsupported servers must yield an explicit unsupported
outcome, not guessed identities or a misleading empty directory.

Every directory request must recheck an active grant, current collection access,
account suspension, revocation, membership/policy binding, and authority state.
Use existing catalog/access-policy helpers rather than an independent SQL-only
permission model. A member can read an authorized directory without receiving
sharing-management powers. Revoking a member invalidates their directory access
as well as record access. Responses should be private and non-cacheable by
shared HTTP intermediaries.

## Person resolution

Use the normalized contract projection, not concrete frontmatter field names.

- No exact issuer/subject match: unlinked.
- One matching record with a unique person ID: linked.
- Multiple matching records: ambiguous, even if their IDs happen to be equal.
- One matching record whose ID also appears on another person: ambiguous.
- Incomplete or failed query: unavailable, not unlinked or uniquely linked.

Do not normalize case, trim subjects, strip issuer slashes, follow redirects,
match by email, or choose the first result. Query all implementing types and
all pages. The Person starter's uniqueness constraint helps but cannot replace
consumer ambiguity handling across arbitrary implementing types.

Editing a person association may change "Assigned to me" just as editing a
task assignment may. Neither changes authenticated audit attribution or
permissions. A displayed collection name may differ from Connect's account
name; do not label it a verified profile.

## TaskNotes integration sequence

1. Add person projection reads and resolution under `TaskRepository`; UI never
   branches on hosted versus connected-computer storage.
2. Evolve the canonical task contract/model to expose person-ID `assignees`.
   Do not silently mutate published task-pack bytes or stash a second durable
   assignment store in browser state. The shared TaskNotes model is another
   coordinated repository boundary.
3. Offer collaborator-backed person suggestions and an explicit create/link
   action. Do not automatically create one note per member on app startup.
4. Add the assignment picker and "Assigned to me" filter. Preserve unresolved
   references; distinguish former members, missing records, and ambiguous
   records from unassigned tasks. Membership does not have to be an editor role
   to be a meaningful assignment target.
5. Invalidate person projections on ordinary collection changes. Directory
   availability and membership changes have their own authenticated lifecycle;
   never infer permissions from cached records.

## Acceptance matrix

- Same account yields the same issuer/subject in two hosted collections and a
  relay collection; a hosted authority transfer does not rewrite identity.
- Self-hosted issuers namespace equal subjects without accidental matching.
- Old grants, denied optional identity consent, expired tokens, revoked grants,
  suspended accounts, and removed memberships cannot disclose identity data.
- A viewer can read an explicitly authorized directory without managing shares.
- No private email or pending invitation data appears in application responses.
- Person notes work with custom field mappings, multiple implementing types,
  pagination, renames, duplicate IDs, and duplicate identity associations.
- Copy/export preserves person IDs and assignments without conferring access.
- Account recreation does not silently claim an old person's tasks.
- Failed identity or person queries do not masquerade as empty/unassigned state.
- Editing an association never changes authentication or membership.

Test with isolated fixtures and the Connect LAB environment, never an installed
user profile. Follow the LAB skill before starting a daemon or browser test.
