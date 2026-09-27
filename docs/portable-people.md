# Portable people and app-visible account identity

Status: implemented on coordinated `feature/portable-people` branches; not
published or deployed. Connect provides app-consented identity/member endpoints,
SDK discovery, and guided person creation/linking in collection settings.
TaskNotes provides link-based assignment editing and an Assigned to me search
filter through its repository. No existing grant acquires identity access.

Companion candidates: `mdbase.person` 2.0.0 in People pack 1.2.0 (1.0.0 remains
in 1.1.0 and is retained by 1.2.0 for upgraded types); `tasknotes.task` rc.5 in
TaskNotes pack rc.15 (task type v3); `tasknotes-model` rc.13 and
`tasknotes-spec` rc.5. Existing published versions are unchanged.
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

- A person is an ordinary record implementing `mdbase.person` 2.0.0, with a
  collection-owned `name` and optional `identities` array. Other records refer
  to it with ordinary mdbase links; there is no separate person ID.
- Each identity has an issuer URL and opaque, account-wide subject. Both are
  matched exactly. Portability is preferred to collection-scoped pseudonyms.
- The association lives in editable frontmatter, not a Connect binding table.
- Connect supplies authenticated account identity and current membership;
  person records never authenticate a caller or grant access.
- Task assignments are links to person records, declared in the task type's
  `collection.links` and resolved by mdbase, never by comparing names, emails,
  account subjects, or membership IDs. Person notes show assigned tasks as
  backlinks, and rename reference updates keep assignments current.
- Reuse `mdbase.contact` for contact semantics rather than duplicating its
  address-book fields. The new Person starter implements both contracts.

Example collection data:

```yaml
type: person
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
records. Assignments link to the resulting record; "Assigned to me" asks mdbase
for tasks whose assignee links resolve to it (for example
`assignees.exists(a, a.asFile() != null && a.asFile().file.path == path)`), so
apps never reimplement link resolution.
Linking a record to the current account is an ordinary optimistic-concurrency
record update; unlinked contacts remain valid and useful without an account.

## Identity and privacy invariants

The issuer is a stable deployment identity, not a hosted provider URL, current
relay route, authority URL, or a value inferred from an untrusted Host header.
It is configured separately as `MDBASE_CONNECT_IDENTITY_ISSUER`, an exact origin
without a trailing slash, and is required outside loopback development (where it
defaults to the local public origin). Production uses `https://mdbase.dev`;
staging and LAB use their own values so test identities never match production.
Changing a configured issuer is an identity migration. Apps never navigate to
the issuer; the identity response carries a separate `person_settings_url`.

The account subject must not be an email, external OAuth provider subject,
membership ID, or recycled identifier. It remains stable across collections,
renames, email changes, provider linking, and removal/rejoining. It is the
dedicated random `users.public_subject` (`acct_` plus 32 hex digits), never the
internal `users.id`, so internal keys can change without rewriting identities
stored in user notes. Recreating a deleted account creates a new row and
therefore a new subject.

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

The application manifest declares required and optional people permissions:

```json
{"requirements":{"people":{"version":1,"required":["identity"],"optional":["members"]}}}
```

Either list may be omitted, but not both; they must be unique and disjoint. The
signed binding includes the exact manifest digest, so the declaration cannot
change without fresh approval. The approving user must grant required
permissions and chooses optional ones in the consent screen; the grant stores
the result in `grants.people_permissions` (NULL for none). Approval without an
explicit choice is refused when optional permissions exist, as for optional
file actions. Declining optional People access still authorizes the app. Legacy
declarations reject this field. Older servers reject the new manifest; older
grants have no people permissions and the new endpoints deny them.

`GET /v1/authorities/:collectionId/identity` returns `{issuer, subject, name,
person_settings_url?}`. The settings URL is present when an editor origin is
configured; it is a route that may change, never an identity.
`GET /v1/authorities/:collectionId/members` returns `{members: [...]}`, adding
`role` to each profile. Both use the control-plane application access token,
including for hosted collections, and each checks the grant's approved
permissions rather than the declaration.

The SDK exposes `connection.people.current()`, `members()` and `directory()`
with typed outcomes, cancellation and bounded requests. A missing endpoint is
`unsupported_operation`; denied consent is `access_denied`; availability failures
are not empty directories. `directory()` performs the resolution below once for
every app. It includes members only when requested and approved; a declined
optional members permission omits them rather than returning an empty list.
The editor uses
normal collection grants to create records or append an identity to an existing
Person-compatible record, and asks for confirmation before linking a record that
already carries another account from the same issuer.
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
`connection.people.directory()` implements these rules; apps should not copy them.

- No exact issuer/subject match: unlinked.
- One matching record: linked.
- Multiple matching records: ambiguous.
- A record that fails projection but still claims this account: invalid.
- Other invalid records are reported, not thrown; they do not block anyone else.
- Incomplete or failed query: unavailable, not unlinked or uniquely linked.

Do not normalize case, trim subjects, strip issuer slashes, follow redirects,
match by email, or choose the first result. Query all implementing types and
all pages. Several records, possibly of several local types, can claim the same
account.

Editing a person association may change "Assigned to me" just as editing a
task assignment may. Neither changes authenticated audit attribution or
permissions. A displayed collection name may differ from Connect's account
name; do not label it a verified profile.

## TaskNotes integration sequence

1. Add person projection reads and resolution under `TaskRepository`; UI never
   branches on hosted versus connected-computer storage.
2. Evolve the canonical task contract/model to expose link-valued `assignees`.
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
- Old grants, declined optional people permissions, expired tokens, revoked grants,
  suspended accounts, and removed memberships cannot disclose identity data.
- A viewer can read an explicitly authorized directory without managing shares.
- No private email or pending invitation data appears in application responses.
- Person notes work with custom field mappings, multiple implementing types,
  pagination, renames, and duplicate identity associations.
- Copy/export preserves person records and assignment links without conferring access.
- Account recreation does not silently claim an old person's tasks.
- Failed identity or person queries do not masquerade as empty/unassigned state.
- Editing an association never changes authentication or membership.

Test with isolated fixtures and the Connect LAB environment, never an installed
user profile. Follow the LAB skill before starting a daemon or browser test.

### Guided setup when Person definitions are missing

Settings offers **Set up person records** in place. It assesses a bundled,
SHA-256-pinned copy of canonical `mdbase.contact` 1.2.0 (the People
pack), shows definition paths and the setup receipt, and writes only after
**Add definitions and continue**. Catalog availability is not a prerequisite.
The bundle is byte-identical to `mdbase-contracts/dist/packs/mdbase.contact/1.2.0.json`
on the contracts `feature/portable-people` branch; updating it requires updating the pinned digest and
contract references together. This does not publish a public catalog entry.

Fresh setup adds only the Person v2 type, implementing both contracts with
optional contact details. Every field, including nested account identity fields,
has usage guidance; the type body explains links, names, contact details,
privacy, account associations and collection-owned customisations. These are
documentation improvements, not validation or contract changes. Existing Contact
and Person types/notes remain untouched; old pack artifacts retain their exact
bytes. A redundant type chooser is hidden when only one compatible type exists.

The guided flow permits additions, preservation of existing seeds, and ownership
of identical existing bytes only. Conflicts, replacements, deletions, or an
incompatible existing Person seed stop for review in Types. Assessment/apply
reuse the existing atomic, digest-guarded engine path, with no auto-adoption of
changed files, record migration, permission changes, or automatic retry.
After approval the collection description refreshes and creation opens directly.
If an existing contact was selected, it stays selected for the separate single-note
conversion review instead of creating a duplicate. Definition-management rights
remain required. Cancellation writes nothing.

### Partial hosted LAB check — 2026-09-14

Disposable LAB checks passed explicit consent, reviewed Contact-only conversion
and linking, self/member discovery, persisted TaskNotes assignments (including
interrupted-write recovery), Assigned to me inclusion/exclusion and explicit
unlinked state after deleting the person. Only unpublished catalog retrieval
used a browser-served fixture; authentication and hosted CRUD were real.

These checks exposed missing pack resource modes, an unsupported `includeBody`
option on semantic Person queries, and native HTML whole-value pattern matching
incorrectly imposed on JSON Schema substring patterns. Regression fixes cover
all three. The first two passed live retests. The form fix passes local tests
and build, but its unfinished LAB deployment requires reconciliation before a
live retest. This is not completion of the full acceptance matrix or promotion
evidence. The run-owned collection and browser were cleaned up.
