# Changelog

## Unreleased

<!-- Add release notes in changelog.d; assembled by pnpm version:set. -->

## 0.1.0-beta.146

### Added

- Add the shared `@mdbase-dev/i18n` kit for locally authored Lingui catalogues, synchronous English startup, lazy language switching and deterministic translation checks. Application adoption is separate.

- Applications may declare `platform: native` to pair from a literal IPv4 loopback HTTP origin on any port. Consent identifies these applications as local and unverified.

### Fixed

- Run `mdbase-i18n` checks through npm-style `.bin` symlinks instead of silently succeeding without validation. A dedicated bin invokes the CLI for every command; packed-consumer tests reject incomplete catalogues.

- Recognize explicit-instance Lingui macros, nested ICU plural/select helpers and instance-field translations in the i18n source guard without exclusions. Check unmarked copy passed to locally rendered React state, including interpolated recovery notices. Track rendered object-state member paths independently from sibling discriminators; do not mistake type literals, truthiness gates or opaque component prop spreads for rendered copy.
- Check app/library translation collisions before runtime with `mdbase-i18n check --compose 'library/{locale}/messages.json'`; report conflicting IDs, locales and values using the runtime's compiled-catalogue merge rules.

## 0.1.0-beta.145

### Fixed

- Allow managed route-back to roll back a stopped migration whose outstanding action is a legacy read (open source or read page) at `created`, matching native rollback cancellation.

## 0.1.0-beta.144

### Fixed

- Allow operator rollback and managed route-back to cancel an outstanding generation-0 window or finish before base append, including fence-first runs still at `created`. Cancellation is atomic with rollback intent; fenced sources still require the existing source binding and receipt-qualified unfence.

## 0.1.0-beta.143

### Fixed

- Skip legacy hosted collections quarantined as `provider_collection_missing` from migration inventories, archives, cutovers and verification, leaving their legacy rows unchanged. Other quarantine reasons remain refused.

### Security

- Update scoped dependency overrides to patched Undici 6.29.1/7.30.1, body-parser 2.4.0, Electron 43.8.1 and Zod 4.6.6, preserving the existing dependency audit gate and exceptions.

## 0.1.0-beta.142

### Added

- Supply the original beta.141 production SDK packet to the Editor's existing target-aware publisher intake; publication still requires separate authorization.

### Changed

- After the desktop app takes over a collection from mdbase Connect, it turns on
  Private sync for it automatically, so apps that used the collection keep
  working without being approved again. Their grants carry over to the Private
  collection when it is created (or the next time such an app connects). Files
  are never changed by this; a failed attempt is retried when mdbase starts,
  after sign-in and on a backoff, and the app and `mdbase doctor` say what it is
  waiting for. Collections that were paused by hand stay paused until resumed.

- Prepare the beta.141 production trust asset bound to its immutable image source, preserving existing production roots, certified policy keys and origins. Authenticated publication, tag push and production promotion remain separate gates.

- Prepare the source-bound beta.141 staging trust asset with the existing independent staging roots and certified policy keys; authenticated publication and deployment remain separate gates.

### Fixed

- Desktop automatically retries moving local collections when an account upgrade becomes available, without restarting the daemon.
- Preserve disabled and paused legacy collections during the move and leave their Private sync off.
- Clarify that local collections remain safe on disk while waiting for an account upgrade, without claiming that the old connector is still syncing.

- Desktop upgrades stop the legacy daemon through its existing private shutdown endpoint and automatically retry moves postponed while it is still exiting. No manual quit or migration retry is needed.

- Keep the Editor’s last-open note collection-scoped and ignore pending note selections after leaving a collection.

- Pin the Editor's default SDK archive to production beta.141 trust instead of staging trust.

- Lower named query selections to string selections and projections so web clients can query local collections on desktop daemon beta.126; preserve application-facing selected value names.

- Managed hosted account migration now processes every held collection in two phases: every member first reaches the verified pre-cutover pause with its timers imported, then each is cut over in turn and the account flips once using combined cutover and timer evidence. Before its first resume the driver records a one-way account latch, and route-back records the opposite one before its first rollback, so a resume whose reply was lost can never race a sibling's rollback. A failure before that latch routes the whole set back to active legacy sources without restarting any member, including members that were never dispatched or rolled back before their fence (each restored from its accepted original archive fence, and only reported done once every source is verified active), also straight after a start that was never bound; the account stays legacy for post-bulk follow-up; after the route-back latch the control plane refuses any late source fence for the account. After the cutover latch the driver only moves forward: `resume` imports every member's timers before the latch, and a Worker whose idempotent cutover reply was lost retries it while it still holds the action. Original ambiguous Worker launches are never replayed, and run bindings from the earlier driver are refused rather than reinterpreted. Transferred history is excluded. The account's single recorded migration start selects the job: an ordinary archived start uses this managed path in LAB, staging and production, while a LAB fixture start keeps its singleton contract; missing, repeated, unknown or cross-environment starts refuse. Live managed multi-collection qualification is pending.
- Transferred hosted history is no longer routed to the hosted migration Worker. An ordinary hosted→local promotion leaves that id as the owner's local collection, so it and any later cloud copy of it use the control plane's own deployments; held collections keep their migration route before and after the flip.

- The production desktop daemon now embeds the reviewed production trust asset
  (`config/next-trust/production.json`), pinned by its SHA-256 and verified at
  load, so synced collections and turning on sync no longer refuse with
  `trust_missing`. LAB and local rehearsal builds are unchanged and still embed
  no production trust.

- After updating from mdbase Connect, the desktop app and `mdbase doctor` now say
  that collections are waiting for this computer to sign in (or for the mdbase
  server to be reachable), instead of waiting for an account upgrade or a
  migration batch. The portal's sign-in page no longer calls an already-used
  computer a "New computer".
- The takeover is recorded in Activity for each collection that moved, and App
  access explains that apps used with mdbase Connect reappear once Private sync
  is on for the moved collections.
- When turning on sync fails, the reason is shown inside the dialog in plain
  words, and the dialog stays open to retry.
- `mdbase doctor` reports a build without trust for synced collections and no
  longer recommends `mdbase sync enable` when that cannot work.

## 0.1.0-beta.141

### Changed

- Re-cut beta.140 as beta.141 without product changes after GitHub dropped beta.140's main push event during an incident. The beta.140 changelog and code are carried forward unchanged.

## 0.1.0-beta.140

### Added

- `@mdbase-dev/ui/collections`: `CollectionGate` and `CollectionPanel` start the SDK front door themselves (`autoStart`, default true, safe with several gates). `extraActions` now appears on every gate screen (beside Sign in when signed out, in the footer otherwise) and can be a function of the screen. App-provided `sections` list collections the SDK doesn't, on the gate's choosing and signed-out screens and in the switcher, and `renderAppCollection` shows one while it's open, with a way back to the list. The switcher takes a leading `icon` (or `"mark"`), rows take an app `rowDetail` line, and `DeleteCollectionDialog`'s `onClose` reports `deleted`, `cancelled` or `failed`. `@mdbase-dev/ui/collections/testing` exports `shareTestDocument()` for Node test setups.
- `collections.css` falls back to built-in values for every design token, so it renders without `tokens.css`, and every value is customisable through a `--mdbase-collections-*` property. The current-row highlight no longer turns pink on grey surfaces written as `oklch(L 0 0)`.

- `@mdbase-dev/ui/collections` and `@mdbase-dev/ui/collections.css`: shared collection UI for apps built on the SDK front door, covering the collection switcher, adding a collection, the gate and blocked screens, sign-out and Manage access. It includes a headless `collectionView`, React components and `mountCollectionUi()` for hosts that don't use React. Problems appear with their fix inside them, collection names wrap instead of truncating, popup calls run inside the click, and the layout works by keyboard and at phone width. The SDK is an optional peer dependency.

- `@mdbase-dev/ui/collections`: rows for a Private collection (the SDK entry's
  `kind: "private"`) show a "Private" label with a lock, in the switcher, its
  header and the chooser. The word is part of the row's accessible name.

- `@mdbase-dev/ui/collections`: app section items take `actions`, shown in the same row menu as SDK collections, with danger styling for destructive ones. An action's `confirmDelete(onClose?)` opens `DeleteCollectionDialog` for the item, so an app can offer "Delete collection…" on its own collections with the usual typed-name confirmation. Closing a row dialog opened from the switcher returns focus to the switcher.

- Shared collection choosers offer Add a Private collection through the SDK.
- Apps can show SDK storage eviction warnings beside their save status; unsupported-browser and unavailable-storage screens retain SDK problem copy.

- Add a source-only native SDK record-operation adapter for the editor integration lane. It requires complete, revision-consistent mutation bases and confirmed, unprotected readback, and preserves exact recovery identities after ambiguous SDK failures. The existing Connect gateway remains active pending shared sign-in and collection integration.

### Changed

- The Editor now registers its offline-app service worker after it first becomes usable, instead of from the page head, so a first visit no longer installs and precaches the whole app while the collection is opening. The large-collection loading budget again measures a real first visit.

- The Editor now uses the public SDK application entry for sign-in, requested collection approval, reauthorization and collection selection. It keeps the bundled registration declaration unchanged and opens the editor only for the SDK's usable, current, ready collection. Demo and Connect-management routes are preserved.

- The native-SDK Editor from `release/native-staging` is now main's Editor. It publishes only through the native dispatch path on `release/native-<target>`; the legacy main and version-tag Pages jobs and their `verify-editor-publication` guard are removed, so no main push or tag dispatch publishes the Editor.
- Old Editor `/connect` links and the **Open Connect** command open the Connect portal for the build's environment (staging builds use `connect-staging.mdbase.dev`).

- Give the editor's existing connection screen owner-supplied native SDK sign-in actions, automatic approval status, popup completion cleanup, and explicit blocked-window recovery. Native collection opening still requires qualified composition inputs; the default gateway is unchanged.
- Pin the release-qualified SDK archive containing the shared native collection factory and provider-receipt helpers, including both Docker dependency-install contexts.

- Prepare the native Editor staging path with the original cancellation-fixed staging SDK and canonical protocol, exact staging entry/installation origins, verified read-only file previews, and a manual branch-preserving immutable publisher. Keep private collection selection and Native lifecycle SDK-owned. Static source/build checks do not imply live acceptance or production authorization.

- Serve a not-found page with status 404 for unknown Editor paths instead of the app shell. Old `/connect` links still open the editor.

- Editor no longer shows Connected while offline. The collection status says "Offline" while the collection can't be reached, and "Saved on this device; waiting for sync" while changes are kept on this device until they sync; the note's save status says the same.

- Pin the editor to the original ad69a506 SDK dev archive with its original connect-protocol dependency archive, installed as ordinary file dependencies in both Docker dependency-install contexts. The archive is a dev intake, not release-qualified.
- Port the editor's SDK mode onto the public `MdbaseApplicationEntry`: `SdkEditorRoot` forwards SDK lifecycle, selection, setup, readiness and connection currentness, and opens the existing editor over a native gateway using the borrowed connection's records, files and people clients. The app-owned native sign-in binding and popup are removed; the Connect gateway remains the production default.

- Pin the editor's original release-qualified SDK837 archive, including shared host/caller lifetime composition and optional bounded SDK832 diagnostics. Keep native collection opening disabled until the editor's own composition is qualified; update both Docker dependency-install archive paths.

- Pin the editor and shared collection UI to the unified sign-in SDK. Native callbacks defer closing the original popup to the SDK until completion and custody acknowledgement.

- Admit production migration routing. Production routes migrated owners only when its own deployment is configured with the production migration Worker origin and distinct tokens; LAB and staging are unchanged and local deployments stay refused.

- Prepare the source-bound beta.139 staging trust asset with the existing independent staging roots and certified policy keys; authenticated publication and deployment remain separate gates.

### Fixed

- `@mdbase-dev/ui/collections`: long collection names wrap in switcher rows even
  when the host app styles `button > span` to one ellipsized line, and the
  switcher trigger shows up to two lines of the name before cutting it short. The
  full name stays in the trigger's accessible name and title.

- `@mdbase-dev/ui/collections`: the setup review plans again by itself, with
  backoff, while the SDK reports a transient refusal (for example another tab
  finishing setup), instead of stopping at "Try again".

- Cache the Editor app shell and lazy assets for offline reloads through the shared SDK build hook.
- Do not offer recovery for edits already in the note; explain why editing is paused when a genuinely unsaved recovery copy needs a decision.
- Preserve another tab's unsaved recovery copy when a saved note is acknowledged.

- Editor now uses local date-time and date-only pickers for schema-declared date/date-time unions, including task schedules and deadlines.
- Properties omits unavailable filesystem size and modification facts instead of showing Unknown. Frontmatter dates remain separate from file metadata.

- Load readable names for generated-filename notes in the notes list without needing to open them first. Meaningful filenames and declared name fields keep the lightweight metadata-only path.

- Editor's Linked from panel now finds links and embeds in native collection notes after content indexing, using the same Markdown parser and target resolution as forward navigation.

- Editor's All notes badge now follows the complete live note index after additions, deletions and pending changes, including notes in Journal folders, while keeping pagination totals during loading.

- Native Editor publication now re-verifies the custom domain for up to five minutes after the immutable deployment passes, so a Pages alias that briefly keeps serving the previous deployment no longer fails an otherwise good publish. Failures on the immutable deployment remain terminal.

- Use the SDK's native file grant for Editor attachment permissions, failing closed when the grant is unknown or lacks add permission.
- Upload through the original SDK file API and report success only after the original receipt and file readback match; keep the original mutation ID on uncertain or retired-scope outcomes.

- Prepare the native Editor LAB entry with the producer-qualified SDK 0fabaf20 and native runtime a350db1c, replacing its previous SDK archive. LAB builds now generate the canonical Editor LAB declaration rather than the production declaration. This candidate is not deployed or live-qualified; the legacy OAuth chooser's collection eligibility and format checks are unchanged.

- The editor declares the file actions that pair with its optional record capabilities, so next accounts no longer refuse its Private collection consent.

- Restore the editor's Send feedback entry, lost when the shared collection switcher replaced the editor's own switcher dialog. It now sits last in the collection rail's fixed tools group, after Types and Settings.

- Use the opening readable line as a display-only name for notes with generated UUID filenames when no name or heading is declared. Editing their body does not write that name into the note.
- Use plain language in type settings, keep type paths and versions under Details, and put undeclared properties on typed notes under Additional properties. Underlying values remain available in Advanced.

- The Editor can open Your person record after person definitions are applied. Contract queries now use bounded pages and continue through the returned cursor instead of requesting an unsupported page size.

### Security

- The Editor now uses SDK-owned, account-bound Native approvals, collection routing and client lifetime instead of an app-owned historical-grant section. Unbound approvals left by older browser sessions are not listed or opened; approve those collections again through Add a collection. Existing browser grants are not imported or relabeled. The pinned SDK attempts whole-store grant cleanup on sign-out; another account's surviving grants remain hidden even if cleanup fails. Isolated custom-adapter lifecycle tests do not add a production fallback.

## 0.1.0-beta.139

### Changed

- Prepare the source-bound beta.138 staging trust asset with the existing independent staging roots and certified policy keys; authenticated publication and deployment remain separate gates.

### Fixed

- Pushes to main no longer redeploy the legacy-SDK Editor to `editor-staging.mdbase.dev`. That build had replaced the native staging Editor, so mdbase-next accounts could never grant it a collection.

- The migration job's completion readback accepts a suspended owner whose migration completed, so suspended accounts no longer stop at `verify_completion` with `lab_completion_missing`. Sharing, timers and every other post-migration guard still refuse suspended owners.

## 0.1.0-beta.138

### Changed

- Prepare canonical beta.137 staging trust metadata while preserving the existing staging roots and certified policy keys.

### Fixed

- A zero-hosted migration cohort whose archive was accepted but which no member ever started can be unfrozen and rerun. Unfreeze advances the cohort's membership revision, so the old acceptance is kept but is no longer current; the rerun freezes, archives and is accepted again. Unfreeze is still refused once any member has started.

## 0.1.0-beta.137

### Changed

- Prepare canonical beta.136 staging trust metadata while preserving the existing staging roots and certified policy keys.

### Fixed

- A migrated account's new collections are created on the control plane's own hosted and escrow deployments. Only legacy hosted collections of a routed owner are served by the hosted migration Worker, so creating a collection after migration no longer fails with 503.

## 0.1.0-beta.136

### Changed

- Prepare canonical beta.135 staging trust metadata while preserving the existing staging roots and certified policy keys.

### Fixed

- Release entitlement reconciliation of active hosted accounts skips accounts whose migration topology is frozen and reports how many it skipped, instead of failing the whole batch and the release.

## 0.1.0-beta.135

### Changed

- Production migration archives use the same scoped-hosted and zero-hosted acceptance profiles, frozen cohort capture, current receiving snapshots, and pre-archive fences as staging, with unchanged environment, membership, retention, and verifier-role checks.

- Prepare canonical beta.134 staging trust metadata while preserving the existing staging roots and certified policy keys.

### Fixed

- Admit the fixed production Connect identity through the same migration CLI and authenticated target bootstrap used by staging, retaining ordinary archive admission, LAB-only custody restrictions and independent deployment-readiness gates.
- Refuse missing, foreign or arbitrary Connect origins before migration CLI database access, including resume and status commands.

- Add a migration-token route that returns a never-started account's hosted collection from a pre-archive fence to active after its archive failed before acceptance. It undoes only Connect's own latest recorded pre-archive fence run, refuses accepted archives, started or cut-over accounts, superseded or changed runs, run-owned replica revocations and inactive authority, keeps the authority epoch unchanged, serializes with the other migration steps and calls the provider once.

- The native scoped recovered-byte proof now admits staging and production data with the provider's default legacy-only `local` key custody, alongside same-environment keys. `local` custody with any KMS reply and cross-environment keys still refuse, and LAB is unchanged.
- Native recovered-byte refusals keep the single fixed stderr line but exit with a stage code: 2 header and environment, 3 key preflight, 4 object proof, 1 invocation or framing.

### Security

- Prepare the production NEXT trust asset from existing certified production public pins and canonical CP/log origins, bound to the immutable beta.134 image release. Publication still requires separate approval; no private keys, signing, deployment or rotation are performed.

## 0.1.0-beta.134

### Added

- Show fixed, content-free SDK opening progress in collection gates; retain the slow-opening fallback for older SDKs or unknown stages.

- Shared collection choosers offer Add a Private collection through the SDK.
- Apps can show SDK storage eviction warnings beside their save status; unsupported-browser and unavailable-storage screens retain SDK problem copy.

- Allow staging migration fixtures to use the existing operator-only legacy invitation option with `@staging.invalid` addresses and `[test]` marking at issuance and signup. Production still refuses overrides, and ordinary invitations keep the configured account backend.

### Changed

- Choose Cloud copy and Private collections from one searchable consent list, with Private lock badges and owner/shared hints. Typing and arrow keys never select or approve; explicitly choose a row before opening the named collection. Keep creation as an explicit action and never preselect a link hint.

- Reduce authenticated hosted-migration claim SQL round trips while preserving
  fresh source/target checks, key locks, one-use nonce expiry and acknowledged
  transaction commits. No protocol, schema, timeout or readiness changes.

- Show the collection picker immediately during app sign-in. One explicit approval confirms the account, waits for the original app's device preparation, and approves the chosen access; browsing and filtering never grant access. Keep the app identity, sign-in warning and Details on the picker, and show the app name when a requesting origin is unavailable.

- Attribute policy-emission failures with sanitized callback phase, nonce/RPC
  step, route name, error code and bounded owned-frame summary. Keep failures at
  error level without logging raw errors, collection identifiers, tokens or
  endpoint URLs; retry, ownership and durable acknowledgment semantics are unchanged.

- Queue policy emission and recovery before database checkout when six policy
  owners are already active in this process. Reserve the other control-plane
  pool connections for foreground work, without rejecting queued policy work or
  releasing its admission before lock cleanup and physical connection release.

- Offer one “Add a collection…” action in the shared collection gate and switcher, using the SDK chooser, coordinated with its hosted/Private picker update. Keep the legacy `allowPrivate` presentation option as a deprecated no-op and `addPrivateCollection` UI action as a deprecated alias of normal Add; leave guards, gesture-bound calls, cancellation and save warnings are unchanged. This does not add new Private collection creation.

- Extend the invitation fixture database constraint to accept the reserved `staging.invalid` domain as well as `lab.invalid`. Runtime staging invitation admission is a separate change; existing invitations and account backends are unchanged.

### Fixed

- Keep collection gate headings focused for screen readers without drawing an interactive focus ring; keyboard focus rings remain on controls.

- Use the shared scanning wordmark and opening status in collection gates, including embedded panels, while retaining account and collection-switch actions.

- Keep “Signing out…” visible when the SDK has published its signed-out screen
  but the original sign-out action is still finishing. Sign in becomes available
  only after that action settles; SDK shutdown and acknowledgment behavior is unchanged.

- After an account's upgrade is paused and returned to mdbase Connect, app sign-in windows now close with a plain explanation instead of asking people to wait and try again. Installation pairing reports the new `postponed` upgrade state.
- The legacy SDK keeps the stored authorization when a token refresh fails for a reason other than the credential (for example a collection being upgraded, a rate limit or an outage), and reports it as temporarily unavailable. Only genuine authorization failures remove it.
- The "collection is being upgraded" message no longer claims changes are safe; it says changes made during the upgrade may not be saved and to check them afterwards.
- Desktop no longer offers "Move to the new sync engine" before the server allows the move, shows why a move was refused, and explains when this computer moved its collections but the account still uses mdbase Connect. The bundled daemon refuses an explicit move the rollout check does not allow, before stopping the old connector.

- Retry hosted query serialization and deadlock conflicts with bounded, jittered exponential backoff inside the existing operation deadline, preserving exact replay receipts and quota accounting under concurrent queries.

- Keep LAB internal migration-source PostgreSQL connections encrypted without pinning Render's rotating self-signed certificate. Source identity and read-only checks remain in place; staging, production, and ordinary database TLS policy are unchanged.

- Confirm native collection member changes before reporting completion.

- Keep collection search usable in short approval windows by showing a bounded
  inline collection list instead of a dropdown that can cover its filter.
  Filtering does not select or approve a collection; existing access and
  explicit approval behavior are unchanged.

- Keep policy emission and recovery serialized without holding SQL transactions
  across log-service calls. Fence writes and append decisions on the same owned
  database session; a disconnected sender cannot acknowledge an uncertain batch
  after another worker takes over. Preserve original retry bytes, recovery order,
  atomic loss scheduling and database timeouts.

- Preserve unsent edits from old hosted mirrors during takeover, rejoin their collections automatically, and show waiting imports, recoveries and conflicts without modifying the old folders.
- Vendor the canonical daemon importer from NEXT #931 (`18f32bd5a`), retaining recovery bytes in its existing owned capture and using fresh rollout permission for explicit retries as well as startup.

- Release collection directory handles after runtime shutdown by updating the
  canonical filesystem engine's derived-cache ownership. Windows cleanup no
  longer waits on a stale global identity handle.

## 0.1.0-beta.133

### Added

- Add migration-service-only, idempotent AppendBase abort-barrier and receipt
  endpoints. A signed freeze fences publication on the original uncutover
  shadow log; metadata alone cannot authorize native cancellation or rollback.
  Requires the separately qualified native publication-exclusion consumer and
  receipt-qualified rollback. Never unfreezes or renews an expired backup hold.

### Fixed

- Replace per-collection account-overview authority, freeze and serving-device reads with set-based inventory queries. Preserve current membership-policy decoding, deletion/suspension denial and permanent device/member-removal rules; validate completed migration evidence once per distinct owner rather than once per collection.

- Keep portal management reads single-flight so slow account loading is not continually superseded by background refreshes. Unavailable initial reads can be retried without signing in again; completed mutations still get a fresh post-operation snapshot.

- Explain account upgrade requirements before app sign-in offers account confirmation, and show policy refusals as the actual blocking state rather than a user cancellation. Upgrading accounts can recheck readiness without granting access.

- Preserve the original Connect-owner migration rollback binding while qualifying the separate provider storage account. Receipts retain both identities atomically, and non-identity accounts can roll back without rewriting an existing intent. Deploy the provider migration and v2 routes before the control plane; the new control plane never falls back to v1. Existing UNKNOWN actions still require their original recovery flow.

## 0.1.0-beta.132

### Fixed

- Keep hosted migration claim issuance available across sequential authenticated reads by counting only unconsumed, unexpired challenges against the subject cap. One-live-nonce enforcement, expiry, proof scope and atomic consumption are unchanged.

## 0.1.0-beta.131

### Fixed

- Allow Node and CLI device-flow applications to use hosted record, sync, and file operations without an `Origin` header when their approved portable capability requires a valid application-key proof. Browser origin restrictions and mirror authorization are unchanged.
- Preserve hosted provider authorization denial codes in typed SDK outcomes instead of reporting them as unknown problems.

- Next-only apps now receive a specific collection-upgrade outcome for an authorized local collection still held by its legacy desktop installation, instead of a misleading offline, key-registration or approval failure. Updating the desktop app is explained in plain language without exposing unavailable collections or granting legacy access.

### Security

- Add fixed production NEXT trust publication and verification under the existing protected release identity, with the same independent publisher/asset pins as staging.
- Allow admin certificate tooling to receive root keys over an inherited pipe instead of a plaintext key file.

## 0.1.0-beta.130

### Added

- Explicit account backend metadata (`legacy` or `next`, default `legacy`), available on the session account response and through a minimal authenticated application-grant endpoint before collection setup.

- `@mdbase-dev/ui/collections`: `CollectionGate` and `CollectionPanel` start the SDK front door themselves (`autoStart`, default true, safe with several gates). `extraActions` now appears on every gate screen (beside Sign in when signed out, in the footer otherwise) and can be a function of the screen. App-provided `sections` list collections the SDK doesn't, on the gate's choosing and signed-out screens and in the switcher, and `renderAppCollection` shows one while it's open, with a way back to the list. The switcher takes a leading `icon` (or `"mark"`), rows take an app `rowDetail` line, and `DeleteCollectionDialog`'s `onClose` reports `deleted`, `cancelled` or `failed`. `@mdbase-dev/ui/collections/testing` exports `shareTestDocument()` for Node test setups.
- `collections.css` falls back to built-in values for every design token, so it renders without `tokens.css`, and every value is customisable through a `--mdbase-collections-*` property. The current-row highlight no longer turns pink on grey surfaces written as `oklch(L 0 0)`.

- `@mdbase-dev/ui/collections` and `@mdbase-dev/ui/collections.css`: shared collection UI for apps built on the SDK front door, covering the collection switcher, adding a collection, the gate and blocked screens, sign-out and Manage access. It includes a headless `collectionView`, React components and `mountCollectionUi()` for hosts that don't use React. Problems appear with their fix inside them, collection names wrap instead of truncating, popup calls run inside the click, and the layout works by keyboard and at phone width. The SDK is an optional peer dependency.

- `@mdbase-dev/ui/collections`: rows for a Private collection (the SDK entry's
  `kind: "private"`) show a "Private" label with a lock, in the switcher, its
  header and the chooser. The word is part of the row's accessible name.

- `@mdbase-dev/ui/collections`: app section items take `actions`, shown in the same row menu as SDK collections, with danger styling for destructive ones. An action's `confirmDelete(onClose?)` opens `DeleteCollectionDialog` for the item, so an app can offer "Delete collection…" on its own collections with the usual typed-name confirmation. Closing a row dialog opened from the switcher returns focus to the switcher.

- Service-local `auth-admin archive drain-deletions` reuses existing deletion workers before migration freeze and refuses unless the current unfrozen cohort and all three deletion queues are strictly known empty. Results are observations, not physical-erasure receipts or capture authorization.

- Add optional `@mdbase-dev/connect/timers` `appTimers(connection)`, a
  retained-app-grant port for the existing opaque control-plane timer HTTP API
  and specific WebPush/FCM channel operations. It does not open a data session,
  expose credentials or retry uncertain writes. `close()` stops this port
  without deleting persistent notifications. Private collection timer
  permissions still require control-plane approval/resolver support; no hosted
  or old data-API fallback is introduced.

- Cloud-copy collections have durable shared catalog names, optional initial naming and an owner-authorized metadata rename API. Existing legacy labels are preserved; private-sync name creation and rename remain unavailable.

- Internal migration tooling can read the current started-owner claim and public SHADOW target tuple without creating a target or changing the legacy provider. These facts do not grant native migration or serving permission.

- Add strictly typed CP nil-registry record/page transport and durable generation-pinned deletion-denial union, retaining committed page denials on failure or drift. Startup serving gates and typed Gone integration follow separately.

- Add bounded candidate transport for device-origin-signed approval metadata between registered USER devices. Metadata queueing and acknowledgement do not activate PRIVATE grants, deliver keys or indicate approval readiness.

- App manifests may declare exact Chrome extension origins for installation pairing, and the approval screen says when a mobile app or browser extension is asking.
- Installation pairing can return the user to the app after approval through a `return_url` that exactly matches one of the app's declared redirect URIs.

- File uploads accept a bounded `maxAttempts` option and `noAutoAbort` for caller-managed recovery. Existing retry and cleanup defaults remain unchanged; callers can choose a single attempt without automatically deleting an incomplete transfer.

- First-party per-installation devices can register with the existing mobile and app-runtime policy kinds, preserving connector proof-of-possession, immutable key bindings, exact enrolment, and current authorization checks.

- The editor opens with a launch entrance: small birds fly in from the edges of the screen, land on the 42px mdbase mark and close up into it, then the mark scans until the collection is open. It plays once per page, lasts under two seconds, holds a fast open until the mark has landed, and is skipped with reduced motion or in a background tab. `OpeningScreen` takes `entrance="flock"` and `@mdbase-dev/ui/screens` exports `useLaunchEntrancePlaying()` for other apps.

- Added audited, migration-token-only hosted source and fence endpoints using the existing provider drain and migration transition. These endpoints preserve legacy run identity and retained journal evidence; they do not enable target serving, cutover or rollback.

- Create or find migration SHADOW targets through the shared service bootstrap while checking the current legacy owner and exact migration start claim.

- Include the original signed genesis bytes and exact hash in bounded authenticated hosted service-device bootstrap records for independent verification before key use.

- Add internal hosted migration rollback receipts binding the exact provider run and requested/restored replicas, with read-only lost-response lookup.

- First-party browser and mobile installations can use the existing device-pairing
  channel to select an account, attest their original device key and request
  explicit device approval. Interrupted exchanges reconcile the same registration
  and installation-scoped credential without creating another device.

- An installation can ask for an optional file action that its manifest declares in `requirements.files.optional` (for example `add`) on one collection it can already open, with a one-line reason. The approval page shows a focused Allow / Don't allow screen with that reason. The decision is recorded for that app and collection, and the app learns the outcome (`file_access_updated` or `declined`) from its request. An installation's collection listing includes approved file actions when asked with `?include=file_actions`. The approval records the person's choice for the app to follow. It does not narrow the installation device's access to the collection.

- Let an app installation end its own device session with only its
  installation credential (`DELETE /v1/next/installation`, used by the SDK's
  `signOut()`). The route revokes the device in each collection it was
  enrolled in, removes its collection access, revokes the credential and its
  background grants, and closes its relay connections. Ordinary connector
  credentials get 403 `installation_required`; an unknown or already revoked
  credential gets 401 `invalid_connector`.

- Recognize a separate LAB cohort archive verifier-result format that preserves per-component runtime provenance while retaining frozen membership, freshness and retention checks.

- Add opt-in fixed-run LAB cloud-copy routing, stateless escrow factory selection, distinct device/app-grant current-authority checks sharing canonical grant terms, separate original CP-principal sending-genesis/current-collection and isolated nil denial-only metadata observations, isolated registry metadata reads, and an owner-session delete/revoke adapter for the Gate4 recovery drill.

- Permit the fixed isolated TaskNotes harness origin `http://127.0.0.1:48218` only for LAB web installation pairing; production, staging and mobile origin policies are unchanged.

- LAB migration fixtures can request a legacy-born account on an individual `[test]` invitation without changing the deployment's default for new accounts. The override is refused outside LAB and is honored through normal invitation signup.

- LAB migration operators can request `lab-run --stop-before-flip` to pause after
  verified H1 and before native cutover preparation. `resume <account>` releases
  only the current paused native run through the authenticated operator entry;
  lost or drifted outcomes stop without retry. Requires compatible hosted Worker
  code; normal runs are unchanged.

- Legacy v4 archive metadata accepts canonical `legacy-archive/` physical prefixes while preserving historical locations, immutable receipts and existing admission checks; routine prefixes remain refused.

- Add bounded, content-free provenance storage for legacy timer imports, with required original-record digests, hashed subject/source identifiers, validated erasure markers and exact timestamp metadata when target microsecond precision loses digits. This schema change does not enable migration or timer delivery.

- Next desktop and CLI devices can explicitly retire a matching legacy local connector after takeover. Retirement requires the exact positive registered inventory, preserves collection, grant and rollback-binding rows, and refuses connectors already registered as next devices. Enrollment, inventory and retirement serialize against current account and connector credentials; retirement does not activate grants, rotate keys or change the account backend.

- Add an explicit local-only server build for isolated migration rehearsals. Its canonical target, service-device factory and claim-proof transports accept only exact loopback origins; managed builds continue to reject local configuration and require their existing HTTPS origins.

- Add native-only local rollback binding preparation with a durable, idempotent result for each collection and rollback ID. Replays do not rotate twice; identity, inventory or binding drift fails closed. Preparation does not reverse account migration, reactivate a connector or authorize application access.

- Add a bounded dedicated-service migration capture inventory for LAB and staging archive preparation, preserving complete membership while excluding terminal accounts from payload selection.

- The operator migration job (`next-migration-lab`) now runs in a staging deployment as well as LAB. It reads the environment from the deployment's own configuration, uses that deployment's canonical Connect origin, requires the ordinary archived start in staging and flips and cleans up timers as staging. Production and local deployments are still refused, and the timer rollback-cleanup HTTP route stays LAB-only.

- A LAB-only operator command, `next-migration-lab`, runs one tiny fixture account's hosted migration end to end (`lab-run`) or routes it back before cutover (`route-back`). It stops for an operator on any unknown outcome and prints the step, the reason code and the commands to inspect and resume. See docs/lab-migration-run.md.

- The operator migration job (`next-migration-lab`) prints one `worker_timeline` JSON line on stdout each time the hosted Worker's migration status changes. The line has the time since the run started, the run state and reason, the native checkpoint step and the kind of the last prepared action. Rehearsal logs now show how long each step took. Polling and decisions are unchanged.

- Migration-token route that queues a member policy item for each current member of a migrating collection on its new target, bound to the current migration claim and provider run. Active members keep their role, members with a pending role change are carried as viewers, and revoked or revoking members and pending invitations are not carried. Repeating the request queues only what changed since, including removing members who left during the migration, and the route returns the exact member map the new backend must hold. The cutover policy now refuses until the target's queued members match.

- Dedicated LAB/staging migration-service endpoints can authorize an original hosted source fence and read its drain before archive acceptance or account start. They require the complete cohort inventory and preserve existing start-gated migration paths.

- Migration-token routes for the fence-first collection migration: list, revoke and unrevoke legacy mirror replicas, unfence a pre-cutover legacy collection, and queue the control-plane `migration-cutover` policy (with `freeze false`) naming exactly the replicas the current provider run revoked. Each route requires the current migration claim and provider run and refuses stale, foreign or superseded ones; rollback steps refuse once the cutover policy is queued, and a repeated cutover request finds the queued policy instead of adding another.
- Hosted provider: a read-only internal route listing the replicas whose revocation the current migration run owns.

- Migration-token routes `…/rollback` and `…/rollback-receipt` in front of the hosted provider's receipted pre-cutover rollback. Both are bound to the current migration claim and the exact rollback binding (with the collection's current authority epoch added by Connect, never the caller) Connect records before the first dispatch, and return the provider receipt only after verifying that it echoes that binding. A receipted rollback also settles the LAB timer rollback cleanup.

- Control-plane routing of migrated owners to the hosted migration Worker now works in staging as well as LAB, configured by `MDBASE_NEXT_MIGRATION_HOSTED_URL`, `MDBASE_NEXT_MIGRATION_HOSTED_TOKEN` and `MDBASE_NEXT_MIGRATION_INBOUND_TOKEN` and admitted only from the deployment's own environment and canonical origin. Production stays refused (`migration_routing_production_disabled`) behind a single code switch; local deployments are refused. LAB keeps accepting its earlier `MDBASE_NEXT_LAB_MIGRATION_*` names.
- LAB cleanup: `POST /internal/v1/next/migration/collections/:id/routing/retire` (migration token, LAB only) retires a disposed fixture collection's migration route, so the control plane stops waking, routing and serving records for it.

- Add migration-token-only source witness issuance using the existing control-plane signer, frozen legacy source observation and authenticated native admission observation. Native authority, revocation and terminal deletion/rollback qualification remain separate activation gates; no application/session or raw-sealer access is added.

- Let native installations request explicit reminder permission for the chosen collection without a legacy OAuth grant. Reuse the existing timer, recovery receipt, sealed channel and notification engines with current installation authority; declining leaves reminders off, and changed permissions require fresh approval without replacing device keys.

- Let a currently enrolled desktop or CLI connector read the exact migration cutover metadata for a current collection it belongs to, including cross-account membership. Sequence fields are lossless decimal strings; the read grants no installation, key, policy or admission authority.

- Device sign-in explicitly confirms the signed-in account for each approval request, including collection access updates, and returns the confirmed email to the requesting app.
- The device approval portal lets users choose a collection or create a named cloud-copy collection before approving access. Final receipts identify the exact approved selection and collections created in that request; existing collections do not receive fresh-creation provenance.

- `MDBASE_NEW_ACCOUNT_BACKEND=legacy|next` (default `legacy`) selects the
  backend of newly created accounts: OAuth sign-up, email sign-up and
  invitation acceptance. Set it to `next` at the all-user cutover so new
  sign-ups can use the new apps at once.
  - A `next` account is created fully flipped: the backend marker, a flip
    record with no collections and the flip audit event, written by the same
    code as the staged migration's flip.
  - The installation sign-in page shows the "mdbase was upgraded" notice only
    to migrated accounts, not to accounts created on the new backend.

- Create cloud-copy collections on the next control plane, behind
  `MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1`:
  - for a signed-in account with no device
    (`POST /v1/next/collections/cloud-copy/service`), where the hosted replica is the
    first member;
  - or from an owner's registered device (`POST /v1/next/collections/cloud-copy`).
  In both cases the hosted and escrow deployments generate their own service
  devices, and the genesis enrols them.
- Enrol an owner's registered device into a cloud copy
  (`POST /v1/next/collections/:id/devices`, signed with a fresh device challenge).
  Private collections refuse this.

- Let a device enrolled in a synced next collection renew its role-0 log
  token (`POST /v1/next/collections/:id/log-token`, signed with a fresh
  device challenge). The token covers that one collection, lasts 15
  minutes, and is issued only while the device's exact enrolment has been
  acknowledged by the log and not revoked. It grants no membership or key.

- Owners can delete a synced collection with `DELETE /v1/next/collections/:id` and its current name as confirmation. Access ends immediately for every account, device and app; stored data is kept but cannot be reached.

- Current registered next-device credentials can read exact public account and collection member metadata for native private/cloud-copy collections. Access requires the current device, acknowledged membership/enrolment and original key tuple; installation collection scopes remain enforced, and revoked historical devices cannot regain access through re-invitation.

- Discover current enrolled cloud-copy hosted Noise targets at an operator-configured origin before daemon fallbacks, without treating enrolment or activation as live readiness.

- Staged migration of hosted collections to mdbase-next, driven by the hosted
  migrator over a dedicated token (`MDBASE_NEXT_MIGRATION_INTERNAL_TOKEN`).
  - Operators release cohorts; there is no user opt-in.
  - One global pause (the rollout starts paused) refuses the atomic per-account
    start claim. An account that has started always finishes.
  - Each hosted collection's cutover is recorded only for the control plane's
    cloud copy with the preserved ID, and routes it to the next runtime.
  - The guarded account backend flip is the only setter of
    `account_backend = next`. It requires every settled hosted collection to be
    cut over, and an evidence digest that the server recomputes from those records.
  - A flipped account cannot create legacy hosted collections.
  - A migrating account's collections are never quarantined as missing.
  - Account deletion during migration is immediate and terminal.
  - Every change is an audit event. The `next:migration-rollout` CLI pauses,
    resumes and manages cohorts and records the operator.

- Return exact account UUIDs alongside portable people profiles for next accounts, behind current user-approved identity/member permissions and active log-grant bindings.

- An enrolled device of a private collection can ask for a fresh SAS commitment
  (`POST /v1/next/collections/:id/private/devices/approval-request`, signed with a
  fresh device challenge). The control plane appends the signed `approval-request`
  policy op; an existing keyed device then approves the device again.

- `GET /v1/next/apps/collections` reports `role` (`owner`, `editor` or `viewer`) for a Private collection while the account is a current member, so apps can show owner actions. It is omitted otherwise.

- Create private (end-to-end) collections on the next control plane from an owner's
  registered device (`POST /v1/next/collections/private`), behind
  `MDBASE_NEXT_PRIVATE_BOOTSTRAP=1`. The genesis enrols only that device, and no
  hosted or escrow device is ever enrolled.
- Enrol a registered device of a current member into a private collection with its
  SAS commitment (`POST /v1/next/collections/:id/private/devices`). The device holds
  no key until an existing keyed device approves it and grants the key.

- Behind the next control-plane flag, serve `GET /v1/next/rollout` to connector credentials: `local_takeover` is true only for an account already on the next backend, the response names only the caller's own backend, and it is never cached. Anonymous, session, app installation, revoked and suspended callers get 401.

- Store service-device records (public keys and KMS-wrapped private keys) for
  hosted-replica and escrow members of cloud-copy collections, and let each
  deployment fetch its own kind's record and refresh a role-0 log token scoped to
  one collection. Inactive unless the next control plane and the matching internal
  service token are configured.

- Installation and reconsent approval links can request a collection. The portal preselects it only from the confirmed account's approvable list; unavailable hints reveal no collection existence and grant no access.

- Add permanent next-collection deletion denial facts outside live-row/account cascades, with immutable CP intent and denial-monotonic native-floor union primitives. Native fence receipts, startup reconciliation and user-facing deletion integration remain separate work.

- Fixed-run control-plane original-admission responses authenticated with the existing certified policy key, exact original genesis anchors, caller challenges, and short purpose-specific freshness. Device and nil-registry admission are excluded.

- Web applications can ask for access to a Private collection. The account owner or a member approves it in the browser, then a desktop of the account approves it on the device; until then the collection is listed as needing approval.
- Collection routes and the installation collection list report availability: available, or unavailable because the desktop is offline, needs an update, is blocked by an older connector still running, still has to approve the app, or because the collection must be set up again after moving to the new sync (`sync_required`).
- Desktops can fetch the terms of a pending Private grant (`GET /v1/next/grants/:grantId/terms`) to show before approving it.

- Web apps granted a Private collection can read its people metadata (`/v1/authorities/:id/identity` and `/members`) with their access token, once a device of the account has approved the app and the person approved people access.

- The hosted provider has `migrating` and `migrated` collection states for the
  mdbase-next migration.
  - Both refuse writes and reads. Replica registration and token rotation answer
    a distinct `collection_migrating` (409), never a not-found.
  - `migrated` needs at least 90 days of `legacy_retain_until`, never shortened.
    The provider refuses it while accepted writes are still in flight.
  - Once cut over, a collection returns to `active` (directly or through
    `migrating`) only with `reverse_verified`. Rollback to `active` can restore the
    replicas revoked during the migration in the same transaction.
  - Compaction is refused and the blob deletion worker never removes a retained
    collection's objects, whatever queued them. Retention is rechecked under the
    collection lock right before each deletion.
  - Deleting a collection or account is immediate and terminal, even during
    retention: its objects are purged and no rollback path accepts it.
  - A drain status route reports the head and the accepted mutations still
    holding a live lease.
  - Nothing calls these routes until the migration runs.

- LAB/staging scoped archive acceptance can bind the original hosted source fence to ordinary account start. Native migration fence/source fronts check that accepted lineage instead of physically fencing the provider again; existing claim, drain and readiness checks remain required.

- Approve first-party installation access to named cloud-copy collections and an explicitly requested create capability. Created collections join only that installation's scope atomically; existing installations use additive same-device re-consent.
- Discover/join collections and read people only within approved UUIDs and current membership/enrolment. Explicit collection removal revokes the app's grants and enrolled installation devices without changing other collections or accounts.

- Add a native selected-archive file recovery component that authenticates legacy collection keys and current/retained metadata, then checks original recovered file bytes against their authenticated size/digest. It returns inventory only, not archive verification or migration acceptance.

- Expose the existing version-aware application authorization compiler from the shared protocol package for native SDK consumers. Connect uses the same implementation: bare full-collection requirements remain semantic v1 with four read-only operations and no file request; explicit declarations and choices retain their original behavior.

- Add a fixed staging trust publication selector that refuses missing or mismatched reviewed assets; ordinary image publication remains separate.

- Each hosted timer import page now records which provider run imported which timers. In LAB, a claim-bound route deletes a rolled-back run's unchanged imported timers after a settled pre-cutover rollback, so a later run can import the collection again. Drifted rows, native timers and other runs' timers are never deleted.

- Admit the explicit LAB/staging zero-hosted archive profile for complete frozen cohorts, with current empty-hosted scope checks at acceptance, start and completion and unchanged elapsed-time and immutable-receipt guards.

### Changed

- Installation device pairing now uses registered application IDs, names, and exact environment/kind origin policies instead of TaskNotes-specific code. Explicit access removal is scoped to the registered application family.

- Application access uses plain-language labels for record types, app setup and scheduled activity. Grants show their exact application origin, identify local development origins, and include the collection ID so collections with the same name can be distinguished.

- The desktop app recognises collection handoff to the newer mdbase runtime and leaves the old connector stopped while migration is in progress.
- A bundled newer runtime can be installed only when the account rollout explicitly allows it; existing newer installations are preserved. The app's own update checks remain available after handoff.

- Check protocol and UI bundle changes on Linux without rebuilding unrelated native release packages. Desktop packaging, native inputs, shared lock resolutions and release dispatches retain their platform checks.

- CORS preflight responses now carry `Access-Control-Max-Age: 7200`, so
  browsers stop sending an OPTIONS request before every cross-origin app call
  (about 190 ms each on a warm app open).

- Apps that have not updated get a clear message when their collection moves to the new sync service: a prompt to reload or update (with the download link and an optional minimum version) instead of a "collection not found" error. While a collection is being upgraded they are told their data is safe and when to try again, and suspended accounts get a plain suspension message.
- The sign-in approval page tells returning users that mdbase was upgraded and that they need to approve each app once to continue.

- Validate exact, bounded hosted migration rollback receipts in the internal provider client without automatically repeating a rollback request after an uncertain response.

- In environment `lab` only, a tiny LAB fixture cohort now completes at its final account flip without an archive acceptance, when every member's LAB start binds the current inventory and every member flipped on its recomputed cutover evidence. Imported timers and original invitation links then work. Other environments never complete a fixture cohort, and a completed cohort can no longer be unfrozen.

- Extend installation pairing regression coverage through initial consent, additive consent, and explicit access removal for the approved TaskNotes LAB loopback origin.

- Isolate an explicitly configured LAB migration account on its own hosted deployment, using authoritative collection ownership and distinct scoped service credentials; other accounts keep their existing routing.

- Make the bounded migration receiving view available in LAB using the existing verified LAB archive profile and unchanged complete-inventory checks.
- Add an explicit LAB-only tiny-fixture start profile, bound to the exact frozen one-account, one-hosted-collection inventory without manufacturing an archive acceptance.

- Clarified legacy archive drain-before-freeze timing, completion closure and removal deadlines separately from routine backup retention.

- An app sign-in refused because the account has not been upgraded yet now says
  where the upgrade stands, in plain words (`details.upgrade` on
  `installation_legacy_backend`). Mid-upgrade, the window stays open with
  **Try again**. Otherwise the window is cancelled, and an account with no
  upgrade scheduled is pointed to support@mdbase.dev.

- Add a bounded complete staging receiving view to the existing migration archive-binding route, preserving its default header and canonical archive checks. Provider fence retries refuse changed migration runs; receiving metadata does not establish original command success, native readiness or ordinary suspended-account access.

- Track provider migration runs and ownership of migration replica updates across rollback.

- The migration rollback and rollback-receipt routes accept an optional `authority_epoch` only when re-reading a recorded rollback; it must equal that original binding's epoch. A fresh rollback still takes the epoch from the collection's current binding and refuses a caller-supplied one.

- App manifests refuse redirect URIs containing wildcards, and installation pairing hands back only through a return URL that exactly matches a declared redirect URI.

- Joining a cloud copy on the next control plane now also returns the
  collection's log URL and its genesis item, so the joining device can verify
  and pin the genesis before it trusts the log.
- Enrolling a device in a private collection on the next control plane also
  returns the log URL and the genesis item, for the same reason.

- Synced next-runtime application approvals and permission changes now queue exact, non-broadening policy grants transactionally. Narrowing rotates the immutable log grant ID, and all SQL revocation/deletion paths queue its revocation atomically. Noise discovery returns the current log identity plus the stable Connect authorization reference; private approval reports bind to the current log identity.

- Present next application permissions as jointly approved record and file actions, refuse missing paired declarations, and preserve exact independent controls for legacy accounts.

- Collections created on mdbase-next are stored in the region nearest their owner. A new collection uses the timezone its owner's device reported at sign-up; a migrated collection uses its hosted collection's timezone, falling back to the owner's other hosted collections. Without a timezone the log service's default region applies.

- A collection's hosted copy on mdbase-next is created in the same region as its log. Connect records the region the log service chose when it created the log and passes it to the hosted service when the collection is activated or admitted for migration. Collections without a region keep the hosted service's default.

- Add LAB-only privacy-bounded service-wake correlation logs (hashed collection tag, role, timestamp, delivery outcome and retry intent); never log tokens, URLs, IDs or response bodies.

- Apps that have not updated now get the same update prompt for a desktop collection that moved to the new sync service, instead of being signed out. Suspended accounts see the suspension message there too.

- Simplified device approval to one named collection picker. Choose an existing collection or “New collection…” and enter its name; Approve creates and opens it. Additional collection access and technical details stay behind disclosures. The primary action becomes visibly enabled immediately after a valid choice. Existing access and per-collection authorization checks are unchanged.

- Rename PostgreSQL test fixtures without changing migration locking or isolation assertions.

- `@mdbase-dev/connect-protocol` validates application manifests with precompiled standalone validators generated from the published schemas. Validation results, issues and strict refusal are unchanged, and the package no longer depends on Ajv at runtime, so browser bundles that import manifest validation are smaller.

- Private collections use account consent alone: no second computer approval or key-code comparison is requested. App access works while the account's signed-in computer is running; Private data stays on that computer. Revocation, exact grant terms, and current membership checks remain enforced.

- Private end-to-end synced collections now support optional cleartext control-plane labels at creation and owner-only rename, using the existing synced collection naming rules. Contents remain end-to-end encrypted; local-only names and installation consent are unchanged.

- Computers can be filtered by name, registration ID or connection status. The count now describes registered computers rather than implying every entry is connected. Registration dates and short IDs distinguish repeated computer and browser-session names; existing revocation and sign-out controls remain explicit.

- Public service-created cloud copies and internal migration SHADOW targets share the same service-device and policy-outbox bootstrap. Retries preserve the original owner, root, runtime, name and service identities; public creation refuses frozen migration topology and deleted collection IDs.

- Allow the authenticated release-trust reference consumer to verify independently supplied staging context, while keeping the fixed trust publisher LAB-only.

- Allow an optional password-signup IP attempt limit for staging and LAB. The default remains 10 attempts per hour, invitation previews share the same limit, and deployments outside staging or LAB refuse to start when the override is set.

- The account migration start records a digest of the account's starter reservation, and the account flip refuses with `starter_reservation_changed` when the reservation changed since the start (or `starter_provisioning_in_flight` while it is being provisioned). The reservation is carried through the flip unchanged.

### Fixed

- `@mdbase-dev/ui/collections`: long collection names wrap in switcher rows even
  when the host app styles `button > span` to one ellipsized line, and the
  switcher trigger shows up to two lines of the name before cutting it short. The
  full name stays in the trigger's accessible name and title.

- `@mdbase-dev/ui/collections`: the setup review plans again by itself, with
  backoff, while the SDK reports a transient refusal (for example another tab
  finishing setup), instead of stopping at "Try again".

- Keep pairing and authorization popups connected to the app that opened them, so the app can close the window when sign-in finishes. Only approval pages and their same-origin sign-in return flow use this policy; ordinary portal pages and API protections are unchanged.

- Fixed migration archive acceptance refusing a full-size cohort: the acceptance request (membership plus every ordered source fence) is now bounded at 1 MiB instead of 4 KiB. Freeze and start requests remain bounded at 4 KiB.

- Fix account collection creation after an account upgrade. Keep the original creation request across retries and reloads so an uncertain result does not create another collection. Use one Add collection panel, with desktop help for adding collections from a computer.

- Keep this browser's sign-out action above the session list, including when sessions cannot load. Show pending and retryable failure states without signing out other sessions.

- Derive app-key fingerprints shown in consent and relay policy from the canonical policy `H(client-fp)` domain hash. Display the first 16 hex characters as `xxxx-xxxx-xxxx-xxxx`, matching native clients. These display strings are recomputed from stored public keys on each response, not persisted; no data migration is needed. Private grant approval already verifies the canonical full digest and is unchanged.

- Keep a connected computer's last-seen status current when its existing relay policy renewal is acknowledged, instead of letting a healthy long-lived connection appear offline.

- Explicitly revoked application grants no longer keep obsolete reauthorization notices that made removed access reappear in account management. Pending authority confirmation remains visible as Revoking.

- Require a nonempty frozen account cohort before migration archive acceptance or reuse, while preserving complete ownership coverage, public binding metadata and immutable historical receipts.

- Hosted and escrow reads honor current collection deletion and device revocation before returning wrapped records or minting log tokens; deleted collections are unavailable in the service directory.

- The hosted provider no longer restarts a semantic projection rebuild from scratch when records are written while it runs: a completed rebuild replays up to 64 changed records through write-path maintenance and activates at the current head. Rebuild batches also stop after about one second, so record writes, notification recovery and the migration fence no longer hit the 5 s lock timeout while a large collection is being indexed.

- Hosted collection renaming checks current action permission under the collection's mutation lock before applying provider or catalog changes.

- Preserve original timer generations, states and timestamps during migration; reject incomplete or conflicting records instead of resetting or skipping them.
- Require complete original account-migration readback before imported timer mutations, firing, receipts or cleanup. Bound stored provenance and prevent an old import from restoring erased timer data.
- `next-timers copy-hosted <collection>` imports every original timer of a fenced, drained hosted collection in bounded pages, verifies the imported set equals the source under one unchanged provider watermark, and records a content-free manifest. The lossy internal timer import route is removed.
- The account flip now requires the next timer service, each legacy source `migrated`, and each hosted collection's timer import to still match the provider watermark, the same legacy run and the target timer rows.

- Replace lossy hosted timer export with bounded, frozen, SELECT-only keyset
  pages preserving original identity, generation, terminal state and timestamps.
  Refuse unsettled or unrepresentable records instead of silently skipping them.
- Close the legacy `copy-hosted` CLI path until strict original-timer import and
  authenticated page consumption are integrated, preventing generation resets,
  omitted pages and replay of previously delivered reminders.
- Add isolated PostgreSQL read-only source regressions for complete multi-page
  inventory, nanosecond originals, expired/unfinished work, SQL/record mismatch
  and missing runtime schema without initializing storage.

- Fixed “Use this account” failing during sign-in for returning accounts with a linked sign-in email.

- GitHub accounts without an email can now confirm device sign-in using their GitHub login. If the signed-in account cannot be identified, the page offers a link to sign in again.

- Device approval no longer shows an empty outlined "Additional collection access" box when there is nothing extra to allow, and the reminders checkbox is no longer drawn as a tall block. `@mdbase-dev/ui` adds `Checkbox` and `CheckboxGroup` (`@mdbase-dev/ui/checkbox`): a labelled checkbox row with a 44px target, and a legend-titled group without the browser's fieldset outline.

- Require explicit selection of the same account before approving a renewed, previously denied first-party installation sign-in; retain the original device and attested keys.
- Clarify that mobile and app-runtime installation kinds carry identical endpoint authority.

- Refuse installation-device sign-in for legacy-backend accounts at selection, attestation, approval and exchange, including replay after rollback; cancellation remains available.

- The device sign-in approval page no longer leaves people stuck after a refused step. Retryable failures offer Try again. When the chosen account can't be used for this sign-in, the page explains why in plain words and cancels the request, so the app stops waiting and can offer sign-in again. An app polling a cancelled request now gets `installation_pairing_denied` and can renew the request.

- Hosted installation recovery can bind START to one immutable collection UUID. Retries, renewals, approval and credential exchange preserve that target and refuse broader, changed, newly created or Private scope without granting access from recovery metadata. Ordinary Add and pending responses retain their previous shape.

- Hosted and escrow deployments' authenticated calls to the control plane's internal routes are now rate limited per service (12,000 requests a minute) instead of sharing the per-IP limit (600 a minute) with public traffic, so many hosted collections behind shared egress addresses no longer receive 429 responses. Requests without a valid service token keep the per-IP limit.

- Route released, frozen LAB migration cohort members to the configured migration hosted deployment without per-run environment edits. Bootstrap, discovery and scoped claim readers share the same DB-backed account classifier; the explicit account CSV remains a fallback.

- Preserve bounded LAB custody failure call, name and message in the private migration diagnostic file, without exposing sub-causes in progress or result output.

- Prepare the canonical SHADOW cloud copy and service-device identity before the LAB migration runner asks the Worker to open custody. Failed preparation stops before Run dispatch; ordinary custody access and serving admission are unchanged.

- Capture LAB hosted-migration Worker ready/run error messages and stacks in an explicit private operator file, without printing raw details or changing unknown-outcome reconciliation. Staging and production do not enable raw capture.

- LAB reserved-account migration routing no longer requires or changes an unrelated default hosted client URL. Authenticated owned discovery uses the validated scoped destination; other accounts retain their configured default or existing missing-default behavior.

- Allow an explicit bounded account UUID list to use the LAB migration Worker, preserving authoritative ownership checks and normal routing for unlisted accounts.

- Allow an explicitly selected LAB rehearsal owner source identity only over the existing exact certificate pin, with PostgreSQL read-only startup options and the canonical timer importer's read-only transaction. Dedicated SELECT-only readers remain required for staging and production.

- Preserve bounded, token-free LAB target-preparation sub-causes in the existing private error capture before Worker Run. Distinguish configuration guards, fetch failures, HTTP refusals and response validation without retrying or changing custody authorization.

- Read legacy hosted mutation journals through their replica-to-collection binding during timer migration. Validate the source query against the actual legacy provider migrations and pinned runtime bootstrap instead of a fabricated journal collection column.

- Require original notification effect admission and unsettled-work drain checks during hosted migration, with an uncapped same-snapshot content-free watermark on the existing authenticated drain response.

- Preserve timer declarations and consent throughout application sign-in, approval, exchange, and background notification handling on explicitly local-built servers. Local declarations require the server's own local environment and an exact loopback origin; managed environment checks and registered-origin authorization are unchanged.
- Reject port zero in local loopback origins.

- Allow registered applications to start device sign-in on explicitly local-built, local-environment servers using exact loopback origins. Managed builds still reject the local environment, and registered origin checks remain required.

- Add regression coverage for local retirement's native UUID ordering, case canonicalization, and duplicate-inventory refusal.

- Admit scoped zero-hosted migration archives and capture in compiled local rehearsal servers, while managed builds continue to reject local archives and local builds reject managed archive profiles.

- The MCP server image build copies the app-ui package's vendored SDK tarball that the workspace lockfile references, so its frozen install no longer fails and release images publish again.

- Preserve binary device keys and challenges in the in-memory database test adapter instead of interpolating lossy UTF-8 SQL literals.

- The hosted migration executor's claim challenge and claim read calls to the control plane are now rate limited per service (4,800 requests a minute per route) when they carry the hosted service credential, instead of 20 requests a minute per IP address, so collections migrating behind shared egress addresses are no longer throttled. Requests without the credential keep the per-IP limit.

- Preserve original emailed hosted invitations across completed account migrations without thawing unrelated topology. Acceptance checks the original flip, current inventory and cutover digest, NEXT registry, archived cohort binding and completed revision; incomplete migrations return a typed retryable `collection_migrating` refusal. Tiny LAB completion remains closed pending its genuine verification/recovery producer.

- Return persisted legacy migration timestamps so first-fence, repeated-fence and drain replies identify the same provider run exactly.

- Preserve finite Worker readiness stage, error name and detail code before migration status reconciliation. Unknown values stay `unknown`/`other`, unrelated replies stay null, and HTTP500 remains UNKNOWN without retry or raw error output.

- The remaining migration-token routes the hosted migration executor and Driver call (fence, source, target, claim read, source-witness, the replica and member/cutover policy steps, and cutover) now count requests carrying the migration token against a per-route service budget of 4,800 a minute instead of the shared per-IP 20 a minute, matching the migration-claim routes. Requests without the token or with a wrong one keep the per-IP limit.

- Preserve bounded HTTP and transport-error classes from the initial migration Worker run reply before status reconciliation, so an absent run no longer hides the request's diagnostic evidence. Never emit response text, exception messages or credentials.

- Push newly approved Private application grants to the consenting account's enrolled Native devices immediately, instead of waiting for policy renewal. Delivery runs after consent commits; an unavailable relay does not undo consent or issued credentials.

- Reuse collection invitations and member management for native synced collections,
  publishing membership additions, role changes and removals through the policy log.
  Invited accounts can join cloud copies with their registered devices after membership
  is acknowledged. Removed devices are not restored by a later invitation.

- Bind Private collection credential completions to the original approved account, application and keys, rejecting incomplete or mismatched authorization records.

- Deleting a synced collection also revokes web-app grants on a Private collection, so they leave the device feed immediately.

- Publish committed Private app requests through the existing log producer before Native feed delivery, without waiting behind unrelated background work.

- Show native collections in Connect management and use the existing People and invitation controls for their authorized managers, without requiring a legacy hosted collection row.

- Native Private collection grants now reach the account's next-device daemons in the relay policy feed (as pending approvals), can be revoked by the daemon through the connector grant endpoint by their log id, and report "computer offline" instead of "approval required" when no serving device is online.

- Requesting the starter collection for an account that has moved to the new system no longer starts the old setup; the response says to open one of your apps instead.

- Wake cloud-copy services immediately after foreground create/enrol policy commits, independently of the background historical verification and catch-up queues.

- Freeze a hosted migration batch before capturing its recovery archive, and fence collection creation, renaming, deletion, import, adoption, transfer and topology cleanup until the migration window permits them. Keep guarded transaction locks alive across bounded provider work and compensation without changing global database timeouts.
- Accept account deletion during a frozen batch, revoke its credentials immediately and terminal-exclude it from migration without changing archive membership. Automatically complete terminal erasure once the whole batch finishes or is audited-unfrozen before archive acceptance, including after a restart or a deletion accepted after the final flip. Deletion outside a freeze remains immediate.

- Activate hosted and escrow collection services after a cloud-copy genesis is appended, with durable bounded retries, so enrolled devices can receive their epoch key without an app opening the hosted copy.

- Wake cloud-copy services after committed device enrolment and other control-policy batches, with restart-safe generation acknowledgments and retries, instead of relying on the polling alarm after the initial activation.

- Keep the app connected to its authorization popup through the `/oauth/authorize` redirect and its sign-in return, so apps no longer treat a Private collection approval as cancelled a few seconds after the popup opens.

- Old application tabs refused after collection migration now tell users to copy unsaved work somewhere safe before reloading or updating. Existing refusal codes, authentication boundaries, and retry behavior are unchanged.

- Keep popover surfaces opaque throughout their entrance animation so approval text does not show through collection lists in small windows.

- Applications can connect with a consistent subset of optional record and file permissions instead of being refused when an optional group is incomplete. Required permissions still need a complete match, and unsupported requests explain that the app needs an update.

- App approval stops waiting after 30 seconds if the app has not finished preparing. It explains how to check the app, connection and desktop client, and offers a retry of the same request without repeating approval.

- Manage accounts, browser sessions, computers, collections, and application access directly on the Connect portal, including `/account`; the Editor links to the portal instead of hosting a second management workspace.
- Show native collections and genuine browser/mobile app installation access without inventing legacy grants or treating app registrations as computers.
- Revoke app access through the existing collection-family and installation sign-out boundaries, including after the original pairing window expires.

- Make the approval collection chooser searchable with an explicit create action first, group application access by collection while retaining individual installation details, style sidebar account links, and open existing Reader manage-access links on Applications.

- Accounts whose migration batch has completed can approve apps, create Private and cloud-copy collections, manage Native sharing and invitations, and rename or delete current next collections without thawing their legacy archive. In-flight batches and legacy topology remain frozen.

- Preserve the complete declaration-bound collection setup pair when projecting Private application permissions, without granting definition administration. Exact record/file pairs and refusal of partial or undeclared operations remain unchanged. Native must independently verify the signed declaration and mediate setup; this projection alone does not enable Private setup execution.

- Make the canonical application manifest parser usable in browser and Worker
  bundles without Node crypto imports. Type-pack document and upgrade-baseline
  digest checks remain synchronous and preserve their existing UTF-8 hashes,
  validation issues, and versioned parser behavior.

- Fixed Private collection relay connections being rejected when a browser also sends its Connect session cookie, including same-site app deployments. The client relay still requires its own valid grant credentials; account and management requests retain their cross-origin protections.

- Keep legacy schema column, nullability, and constraint checks in the active PostgreSQL schema when bootstrapping isolated databases.

- An app that declares its application ID now connects after its manifest changes: the SDK accepts the new ID Connect registers for the changed manifest when every registration check matches the manifest it sent, and keeps the app's declared local storage names.

- Allow self-registered apps to pair from their declared web origins, with optional exact native and loopback origins, while retaining explicit device and collection consent.

- Complete private-account strict mode from signed applied revoke/rekey witnesses across all member devices, rather than requiring one device to host every private collection. Strict retries retain their operation version; status lists missing witnesses until completion.

- Allow the dedicated migration service to migrate suspended accounts while preserving suspension and ordinary access restrictions.

- Let explicitly approved local PostgreSQL tests migrate isolated schemas in parallel while retaining same-schema serialization and the unchanged production-wide migration lock.

- Recover uncertain timer metadata mutations with bounded, authenticated original-operation receipts instead of reapplying desired snapshots to newer generations. Fence namespace intents and recheck current consent after transaction lock waits.

- Offer one Add collection action with a location choice, including the existing desktop handoff for linked Native computers even when Hosted is disabled. Private badges name the exact enrolled computer and its presence; Hosted badges remain Hosted. Preserve original creation requests across uncertain outcomes and allow the canonical Hosted creator after verified account migration completion without clearing the archive freeze.

- Private collections appear in the normal app Sign in/Add chooser alongside cloud copies. Approving Private composes the original signed Native authorization with account-only installation registration; it never grants a Private ID to a Hosted Worker or asks for computer-side confirmation.

- Older applications with complete permission groups can authorize a consistent subset on the next runtime without expanding their declared rights. Required permissions and fixed file actions remain intact; original signed declarations and existing grants are not rewritten.

- Make the cold-runtime shutdown regression synchronize on the actual opener, and account for Windows' existing per-folder delete-share cleanup budget without changing shutdown behavior.

### Security

- Update transitive source-map and PDF viewer dependencies to patched releases while retaining the dependency audit gate.

- Add an own-collection migration claim read for hosted deployments, requiring a current service-key proof and isolated one-use challenge rather than sharing operator migration credentials.

- Refuse collection log-token refresh when permanent CP deletion facts are already known, including for otherwise eligible restored collection metadata. This local denial does not replace native deletion/currentness fences.

- Verify the LAB migration reader's internal PostgreSQL CA and exact certificate identity within its dedicated source connection; normal control, public, staging and production TLS policy is unchanged.

- Require exactly 116 elapsed days of archive retention after original completion, a capture lasting at most 24 hours, and unchanged current membership for migration admission. Preserve historical receipts without allowing them to satisfy new claims.

- Require a fresh verified v4 legacy batch archive before every hosted-migration start or retry; bind immutable acceptance to current account membership and hosted-collection ownership, using the dedicated migration verifier boundary.

- Define canonical, environment/source-bound NEXT public root and policy pins as authenticated release-bundle assets. Require exact origins, certificate/key-ID validation and signed-manifest digest binding; do not publish operational pins or permit unsigned LAB trust.

- Authenticate reviewed LAB NEXT trust assets with a release-linked inventory signed by the existing protected image publisher; retain immutable image bundles and independently verify producer/release qualification and asset context.

- Add versioned CP-only pre-key replay registration with signed nonce and request-digest bindings, committed PostgreSQL uniqueness, persistent cutoff data and bounded live quotas. Required actors still refuse serving until native authentication, clock continuity and old-writer drain are qualified.

- Update Sharp to 0.35.5 (including its patched image-library binaries) and require MCP SDK 1.31.0 or newer, resolving dependency audit findings without adding audit exceptions.

- Require independently approved publisher and canonical asset hashes for the fixed staging trust publication operation; reject missing or changed inputs before publication. LAB publication remains unchanged.

- Refresh TLS, AWS configuration, and HTTP cache dependency pins to upstream patched versions while preserving existing SDK features. Remove the resolved HTTP cache audit exception.

## 0.1.0-beta.129

### Added

- In opt-in mdbase-next account mode, successful pairing identifies the approved
  account. Explicitly negotiated grants and activation carry consenting account
  identity without changing legacy projections or default capabilities.

### Changed

- mdbase-next routing returns only devices of the account that granted the app,
  always uses `wss:` outside loopback development, and orders targets by online
  status, daemon preference, then recent activity. `online` is a read-only hint from
  the current device-bound relay owner, not a recent policy acknowledgement or
  authorization proof. Local routing still has one desktop/CLI device; mobile
  registration is not added. The app collection list leaves out hosted collections
  that are not active or are quarantined.

### Fixed

- Prevent hosted transfer expiry and recovery races from discarding renewed imports
  or in-flight activation. Cleanup applies only to the winning transfer and its
  exact candidates.
- Account overview and hosted control reads no longer run transfer cleanup. Hosted
  expiry runs in bounded background batches. Update Connect and its hosted provider
  together; an older provider leaves expiry pending rather than falling back to
  ordinary cancellation. Explicit user cancellation remains available.

- Browser clients can preflight authenticated PUT requests, including timer writes,
  without changing allowed origins, credentials, or endpoint authorization.

- Fix request signing for opt-in mdbase-next log integrations, binding signatures
  to the current request method, path, collection, token, body and nonce.

- Prevent deadlocks between hosted projection batch persistence and concurrent projection startup by acquiring collection locks before generation locks.

## 0.1.0-beta.128

### Added

- A `free_v1` entitlement profile for the mdbase-next free plan: one synced
  collection, a provisional 250 MB storage cap, one member seat and files up to
  100 MB. No account holds it until an operator runs
  `auth-admin entitlements backfill-free`, which grants it to every account in
  bounded, idempotent batches. Beta accounts keep their limits, because effective
  limits are the maximum across an account's profiles.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, an app can register its mdbase-next Noise key
  at consent with `client_noise_key`, an attestation signed by the grant signing key
  that its authorization binding certifies. The server verifies it and refuses weak
  keys, then copies it to the grant on local and hosted approval. Daemons receive the
  key and its attestation in the grant feed, and the consent screen shows the key's
  fingerprint. Authorization bindings stay at v5, so today's connectors are
  unaffected.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, a connector can register an mdbase-next device
  with proof of possession of its signing key (`POST /v1/next/devices/challenge`,
  `POST /v1/next/devices`), and bind it to its relay socket with `device_bind`.
  Connectors that negotiate `next_device_v1` receive each grant's capability groups,
  Noise client key and fingerprint in their policy snapshots. Existing connectors see
  no change.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, a daemon reports a device's approval of a grant
  on a private synced collection (`POST /v1/next/grants/:grantId/approval`), with the
  capabilities the user approved and the app key's fingerprint. The report is signed by
  the device key and checked against the log. The control plane honours only the
  approved capabilities, keeps the earliest approval in log order, and stops counting
  an approval when the grant's terms change.

- With `MDBASE_NEXT_CONTROL_PLANE=1` and `MDBASE_NEXT_HOSTED_INTERNAL_TOKEN` or
  `MDBASE_NEXT_ESCROW_INTERNAL_TOKEN` set, the hosted replica can read each
  collection's state (`standard`, `private`, `local` or `unknown`; a collection that
  has left sync, marked in the new `next_collections.left_sync_at`, is `unknown`) from
  `/internal/v1/next/collections/:id/state` and the batch
  `/internal/v1/next/collections/states`.

- Add separately authorized, hard LAB-environment/origin-guarded disposable private-log fixtures using ordinary registered device proofs and the configured policy certificate. Fixtures have bounded quotas, short-lived collection-scoped tokens, exact creator-owned cleanup and durable tombstones. The routes are absent unless explicitly configured in LAB.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, the relay carries mdbase-next Noise sessions
  between apps and daemons (`GET /v1/next/relay/client` and `noise_pipe_v1` on the
  connector socket). The relay forwards opaque bytes, routes only to the named
  device's currently bound socket and checks the device's registered Noise key. It
  works across instances through the relay broker.
- An open relay pipe re-checks its app token and grant every 30 seconds and closes at
  both ends once either is revoked, as a backstop to the daemon's own revocation.
  It also closes when authorization cannot be revalidated.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, the server keeps an outbox of mdbase-next
  policy ops, written in the same transaction as the change that implies them, and
  appends them as signed policy items to each collection's hosted log. Lost responses
  are retried with the same bytes, a moved head rebuilds the item, and refusals park
  the collection's queue. Private-sync collections can never enrol a hosted or escrow
  device. Requires `MDBASE_NEXT_LOG_SERVICE_URL`, `MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY`
  and `MDBASE_NEXT_LOG_TRANSPORT_KEY`.

- Behind the disabled-by-default next control-plane flag, periodically verify acknowledged policy positions and reissue missing policy batches with their original operations and subjects.
- Accept authenticated owner-connector hints that only schedule verification, and report parked policy work as unready.

- The server can sign mdbase-next policy items with a control-plane policy key
  certified by an offline root. It is off unless `MDBASE_NEXT_CONTROL_PLANE=1`; when
  on, startup checks the key, its certificate and its expiry, and every item is
  refused outside the certificate window. `next:cp-cert` issues certificates and
  key revocations offline, always from structured input that it prints before
  signing.

- With `MDBASE_NEXT_CONTROL_PLANE=1`, `GET /v1/next/collections/:id/route` tells an
  app with an access token where to open its mdbase-next Noise session. Each target is
  `{kind, device, noise_pk, url, relay_collection}`; for a local collection that is its
  daemon, through the relay. Grants without a registered Noise key get
  `409 client_key_required`.
- `GET /v1/next/apps/collections` lists the collections the calling app installation
  can switch between, one per active grant, with their state and whether they can be
  routed over Noise.

- The server can run the mdbase-next opaque timer service. It is off unless
  `MDBASE_NEXT_TIMERS=1`. Apps put, cancel, list and reconcile one-shot timers
  with their access token, under
  `/v1/next/collections/:collection/timers/:namespace`. The service stores only a
  timer ID, a criterion and a UTC time, plus optional `data` for hosted (cloud
  copy) collections. Each fired generation is one fired-timer event. Push and
  webhook delivery consume those events through the existing notification
  service.
- `next:timers copy-hosted` copies a hosted collection's active timers at
  cutover.
- Push channel targets (Web Push endpoints and keys, FCM tokens) can be sealed at
  rest with AES-256-GCM by setting `MDBASE_NEXT_PUSH_TOKEN_KEY` and
  `MDBASE_NEXT_PUSH_TOKEN_KEY_ID`. `next:timers seal-push-targets` seals
  existing rows. `unseal-push-targets` restores plaintext before rolling back to
  a release that predates sealing.
- Push channel registration and push and webhook delivery refuse grants on
  mdbase-next private-sync collections until device approval can be checked.

### Changed

- This beta brings the collection-availability, mirror-handoff, activity-log and
  background-polling fixes to users upgrading from beta126. Beta127's prepared
  changes are included; beta127 was not published.
- Preparatory mdbase-next server features remain disabled in managed staging and
  production. This release does not migrate collections to the new runtime or
  enable its control plane, encrypted relay sessions or timers.
- Server upgrades apply additive control-plane migrations 0037–0046 plus 0045a,
  even with mdbase-next features disabled. Migration 0039 adds the `free_v1`
  entitlement profile but assigns it to no accounts; no entitlement backfill is
  part of this release. An image rollback leaves the added schema and profile in
  place rather than reversing these migrations.

- A local collection whose folder a newer mdbase runtime has claimed is now
  reported as claimed instead of paused. Operations fail with
  `collection_claimed_by_newer_runtime`, whose message no longer includes the
  folder's absolute path; `collection list` shows `claimed`; `doctor` warns;
  the desktop app explains the move and offers removal; and the inventory sent
  to the server carries `unavailable_reason: "claimed_by_newer_runtime"`. The
  daemon stops polling the collection and releases its runtime instead of
  logging a warning every second, and the collection can now be removed from
  Connect. Invalid role-marker messages also no longer include absolute paths.

- `watch`, and the `observe` and `connection.watch` APIs built on it, now poll
  for changes at most once a minute while the browser page is hidden, and poll
  immediately when it becomes visible again. Outside browsers, and in visible
  pages, the requested `pollIntervalMs` is unchanged.

### Fixed

- The connector's local application activity log no longer grows without
  bound: it keeps the newest 10,000 entries, pruning older ones as new
  entries are recorded (at most 1,000 per entry, so a large existing log
  shrinks gradually). Listing activity reads the newest entries directly
  instead of sorting the whole log. No registry migration is required.

- An application whose grant is still valid now receives HTTP 409
  `collection_unavailable` with `details.reason` (`paused` or
  `claimed_by_newer_runtime`) when its local collection is unavailable,
  instead of a misleading 401 "Access token is invalid or expired." The
  server stores the reason reported by connectors (migration
  `0037_collection_unavailable_reason`), and the Connect portal shows
  "Moved to newer runtime" instead of "Paused" for a collection a newer
  mdbase runtime has claimed.

### Security

- Hosted mirrors now re-check the folder's `.mdbase/connect-role.json` marker
  before every sync. If a newer mdbase runtime has claimed the folder (a v2 or
  later marker), the mirror stops with `collection_claimed_by_newer_runtime`
  instead of uploading the folder's changes, and `mirror remove` leaves that
  marker in place. Previously a running mirror kept syncing a claimed folder
  and removal deleted the claim.

## 0.1.0-beta.127

### Added

- SDK `observe(query, options)` owns progressive live-query snapshots/deltas,
  batched changed-path rereads, capability-gated metadata membership and exact
  revisions, reset/gap reconciliation, cancellation and local-write overlays.
  Manual mode refreshes without watch. Replace collection synchronization
  workers, not domain indexes or draft/session logic; see `docs/sdk-observe.md`.
  Initial loads use full-row query pages, reserving metadata/document batches for
  deltas. Terminal pages no longer release an already consumed query/view cursor.
  Errors stop synchronization until explicit reconciliation; accepted writes
  always queue confirmation in watch mode, and initial readiness follows any
  superseding refresh or hydration. Later qualified echoes reuse confirmed base
  rows without another document read, while authority metadata refreshes file facts.

- SDK `readMany(paths, { revisions: false })` keeps read-only hydration in typed
  path queries, defaulting to 1,000-path batches without document discovery or
  separate type selection. Revision-bearing defaults are unchanged. Migration:
  replace hand-written body queries with this option (use `batchSize: 500` for
  Writer's existing payload size); retain the default for revision-safe editing.
  See `docs/sdk-query-helpers.md` for the result and error contracts.
- MCP `query_records` accepts capability-gated `output: "metadata"`;
  `list_changes` adds SDK-normalized `typed_events` alongside unchanged raw
  events. The MCP manifest and permissions remain unchanged, as does the
  record-only `read_record` tool. File stat is not exposed through MCP; no new
  consent or shared grant-model change is required.

### Changed

- The editor uses SDK query observations instead of its separate collection
  load/watch, structural reconciliation and overlay workers. Asset opens use
  capability-gated `files.stat` before downloading a pinned revision. Record
  sessions, drafts, file inventory and presentation indexes remain app-owned.
  Newest-note startup uses a separate bounded query without ordering the live
  observer; failure of that auxiliary query does not disconnect the collection.
  Stopped synchronization is shown explicitly with connection retry.

### Fixed

- The desktop app keeps showing "Computer approved. Connecting securely…" until
  it relaunches after pairing, instead of briefly switching to the collections
  view when a background refresh sees the new account first.

## 0.1.0-beta.126

### Added

- Note context menus (rename, move, duplicate, copy link or path, pin, delete
  with Undo), drag notes onto folders, multi-select with bulk move, tag,
  property and delete actions, and pinned notes.
- Paste or drop images and files into a note to upload them in place.
- Commands in quick open (`>` or Ctrl/⌘+Shift+P), focus mode with optional
  typewriter scrolling, and unlinked mentions under "Linked from".

### Changed

- Editor browser qualification uses responsive light/dark readiness, font/image loading and overflow checks instead of platform-specific PNG screenshot baselines. Local runs no longer require baseline updates or a matching container.

- The editor has a calmer, more consistent design: Atkinson Hyperlegible Next
  with a shared type scale, filled primary buttons, proper switches and
  checkboxes, sentence-case labels, and less monospace. Saving is silent unless
  it is slow or fails, Properties docks without covering or rewrapping note
  text, and paths keep their filename visible.
- The rail has one collection menu, folder rename and move with a confirmation
  that counts affected notes and links, and Types, Settings and Connect pinned
  below the folders. Tags and types are search filters (`#tag`, `type:`).
- Image and file embeds, Types, Settings, note creation and the mobile layout
  are quieter, with larger touch targets. Connect sign-in, sign-up and password
  reset use one centred layout with a primary action and a single divider.

### Fixed

- Authentication accessibility checks now enforce the shared typography tokens,
  heading hierarchy, filled primary action, and email/provider divider without
  requiring the previous uniform type treatment. Development sign-in preserves
  its system-test accessible names; successful auth configuration clears obsolete
  session-lookup errors without hiding authentication return errors.

- Prevent local CLI batches from timing out with `outcome_unknown` when background
  filesystem ingestion overlaps durable settlement. Runtime background writes now
  share the collection mutation permit; exact revisions, recovery behavior, and
  operation deadlines are unchanged.

### Security

- Update MCP HTTP framework and server IP address parsing dependencies to published
  security fixes. Also refresh affected glob expansion, date parsing, and test
  tooling dependencies without changing Connect's protocol or authorization model.

## 0.1.0-beta.125

### Changed

- Release notes and architecture-growth justifications now use per-change
  fragments so queued PRs do not edit shared release counters. `pnpm version:set`
  prepares beta versions, assembles notes, and refreshes architecture snapshots;
  generated inventories are verified in CI and regenerated after source rebases.

- Seed type upgrades follow mdbase-spec 05A's upgrade baselines
  (mdbase-dev/mdbase-spec#59), with mdbase-rs 056db73 pinned
  (callumalpass/mdbase-rs#108). A type pack's seed `upgrade_from` may now be one
  baseline or a non-empty list of `{ digest, document, version? }`; manifest
  validation (`validateAppManifest`, and the new `validateTypePackProvision`
  in `@mdbase-dev/connect-protocol/manifest`) rejects baselines on non-seed
  types, digest mismatches, duplicates, the resource's own digest, a different
  frontmatter `kind` or `name`, and a `version` the document does not declare,
  at the offending baseline's path. The single-object form is unchanged.
  Engines choose the merge baseline from the lock's seed `origin_digest` and
  preserve, with a reason, a seed whose origin is unknown or unlisted. The
  SDK's type-pack assessments add `upgradeBaseline` to seed updates, and
  receipts add `originDigest`. The devkit's `defineTypePack` accepts
  `upgradeFrom: [{ document, version? }]` on seed types. The editor's guided
  Person setup accepts a starter upgrade only when the engine reports a
  baseline the bundled pack declares, and says **Person type kept as it is**
  when the engine preserves the type with a reason.

### Fixed

- The editor's guided person setup bundles `mdbase.contact` 1.4.0, whose Person
  v3 starter lists both earlier starters (Person v2 from 1.2.0 and Person v1
  from 1.1.0) as `upgrade_from` baselines. Collections still on the Person v1
  starter, which implements `mdbase.person` 1.0.0, now see **Person type update
  available** and can review the same in-place upgrade instead of being asked to
  set up person records. The released Contact seed is left as it is. No API
  changes.

- Manifest validation and the devkit's `defineTypePack` accept seed upgrade
  baselines whose frontmatter uses YAML anchors. They now read only a starter's
  top-level `kind`, `name` and `version`, without alias expansion, instead of
  rejecting the whole document; TaskNotes' first task starter uses an anchor,
  so its `tasknotes.task` manifests failed validation.

- The editor's guided person setup installs `mdbase.contact` 1.3.0, whose
  Person v3 starter neither declares nor requires `type`. People created in
  collections whose `settings.explicit_type_keys` is not `[type]` (such as
  `[mdbase_type]`) no longer fail validation with `schema_required: type`.
  Person v3 carries `upgrade_from` the 1.2.0 Person v2 seed. When a collection
  has that earlier starter, Settings now offers **Review Person type update**:
  the guided review names the upgraded type, says whether collection edits are
  kept by a clean merge, and applies only the reviewed assessment digest.
  Conflicts, deletions, downgrades, managed-resource updates and seed updates
  without a matching `upgrade_from` still stop for review in Types. No API
  changes.

## 0.1.0-beta.124

- Migration note for SDK consumers: the client's `queryPages` gains an overload
  for `output: "metadata"` rows. Test doubles that implement the connection's
  `queryPages` structurally must accept the metadata overload (TypeScript
  reports TS2322 otherwise). Runtime behaviour is unchanged for ordinary queries.

- Hosted required links to ordinary files (including Reader's HTML, PDF and
  EPUB documents) now validate against committed file metadata from the same
  authority snapshot. Writes and explicit validation no longer report an
  existing attachment as missing. Attachment bytes are not downloaded or parsed
  as records; missing, deleted and unfinished-upload targets remain invalid.

- Application-session startup no longer tears down replacement verification
  when a route or selection refresh cancels an obsolete setup assessment.
  Only that generation's expected cancellation is ignored; genuine exceptions
  and current assessment failures remain visible. No public API or
  authority protocol changes.

- `readMany(paths, options)` now uses revision-bearing document batches when
  `read-many-documents-v1` is advertised, retaining typed path queries otherwise
  with zero extended requests to unsupported authorities. Signature, ordering,
  duplicates, body/frontmatter options and bounded scheduling remain unchanged.
  Type filtering stays authority-owned via query preselection; subsequent reads
  return their own content+revision pair, not a discovery token. Qualified reads
  require existing read approval. Legacy consumers still need revision reads;
  exact Markdown and full record documents remain the point-read API.

- Record-session watch following bounds refresh admission to four sessions and
  coalesces event bursts, so a change gap across 1,000 open records no longer
  leaves most records silently stale. Transient read failures retry with
  backoff; failed refreshes remain visible through the existing `error` and
  `problem` snapshot fields. Reconciliation preserves write ordering and waits
  for exact recovery. No consumer API changes are required; existing error UI
  should handle read failures as well as write failures.

- Client query/view iterators release paused cursors on abort and accept an
  opt-in `maxResults` total cap (`limit` still means page size). Cursor `pageSize`
  controls the initial pinned size; continuations omit `limit`. Migration:
  remove small `firstPageSize` overrides when a larger cursor scan is intended;
  the error-based adaptive-size retry is removed. TaskNotes can drop its paused
  iterator abort workaround. `readMany(paths, options)` adds typed, escaped,
  bounded path batches with input ordering, missing entries and batch failures;
  current query results carry no revisions, so revision reads remain necessary.
  `linksTo(field, path, {multiple?})` builds authority-resolved scalar/list CEL
  predicates. See `docs/sdk-query-helpers.md` for semantics and migrations.

- The client SDK exposes discriminated change events with camel-case record,
  schema, configuration, contract, view and file metadata. Original event IDs,
  payloads and wire events remain available; unknown IDs/payloads and feed gaps
  are explicit variants. `describe()` caches successful results for up to 60
  seconds, shares concurrent loads, and invalidates on structural events and
  accepted schema mutations. `schemaGeneration` tracks local invalidation;
  `describe({ fresh: true })` forces an authority refresh. The editor consumes
  typed events and no longer discards configuration/contract changes. Migration:
  use `kind` and typed fields instead of raw-ID heuristics; normalize custom test
  events and pass `fresh: true` when every description must reach the authority.

- The SDK discovers authority-local implementation features through approved
  descriptions or file listings, sharing in-flight discovery and caching only
  for the current connection/route lifetime. `files.stat({path}|{fileId})`
  returns typed metadata/null outcomes with a capability-gated legacy listing
  fallback. Metadata query output is opt-in and revision-required; unsupported
  authorities receive no extended requests. Existing query/list callers are
  unchanged; metadata consumers must retain their ordinary-query branch until
  minimum-authority, consumer-adoption and rollback gates close. No authority
  capability is advertised by this SDK change.

- Native v0.3 authorities transport exact-source query revisions, bounded ordered
  document batches through `read`, and opt-in `output: "metadata"` queries with
  no full frontmatter/body envelope. Local and hosted adapters share mdbase-rs's
  evaluators/renderers; contract output variants await B5. Consumers must use B1
  positive capability discovery and retain old-authority behavior, never infer
  support from errors. Hosted projection format 9 requires a derived-generation
  rebuild; query plan 13 invalidates predecessor cursors. Payloads/database schema
  are not forward-only, but rollback requires predecessor projection rebuilding
  and cursor restart. See `docs/architecture/sdk-wave-b-authority.md` for limits,
  migration, rollback and the 30k-row transfer benchmark.

- Directory mirrors (`@mdbase-dev/connect-sync`) recover from routine local
  interference without a person: a scoped blocking issue (an obstruction,
  divergent or unreadable file) fences only its own path and connected path
  transitions, so independent files still sync while the checkpoint waits.
  Writes pass the inspected text to the adapter, which can reject a competing
  edit at its atomic write boundary; the stale batch is then released so the
  next review reports a conflict instead of replaying the old plan forever.
  Adapters that report physical path kinds turn a folder occupying a
  destination into an actionable blocking issue rather than an impossible
  write. Inspection no longer downloads attachment bytes; they are fetched,
  verified and reported through the caller's cancellable transport only while
  applying, and an abort mid-transfer is recorded as a pause that the next sync
  resumes. `DirectoryMirror.review()` returns the plan and its status from one
  inspection; `status()` now uses it.

- Re-registering or pairing a connector again clears obsolete cached remote
  grants and its previous connector identity, instead of leaving the relay
  permanently disconnected. Local collections, access controls, transfer fences,
  device identity and recovery evidence are preserved. A mismatched policy now
  reports an actionable registration error instead of retrying as a transport
  interruption; a live account change requires a daemon restart.
- Hosted writes enforce unique values and required links using canonical engine
  validation. Valid no-op updates return the stored record and a replayable
  receipt instead of failing. The engine update rebuilds hosted projections and
  provider migration 0045 adds the targeted uniqueness-key index.
- Concurrent upload finalizations use separate destination objects, so a delayed
  copy cannot overwrite content another attempt verified and published. Object
  cleanup is durably queued with publication.
- Hosted imports preserve their exact local source authority during inventory
  refreshes and resume durable transfers safely. Server migration 0036 narrowly
  repairs historical source demotions without clearing local transfer fences.

- Approving an application no longer re-reads the whole local collection.
  Activation and account-driven setup finished with a full runtime
  synchronization that parses every record; setup is a runtime mutation, so
  it is now finalized like any other, and an application that declares no
  setup finalizes nothing. On a synthetic 30,000-note TaskNotes collection
  each approval saves about 0.9 s: a first approval takes 3.4 s instead of
  4.4 s, and a repeat approval 0.15 s instead of 1 s. The agent logs each
  activation's phase timings (`application authorization activated`) and
  each requested runtime reconciliation's queue, synchronization and
  finalization time (`runtime reconciliation completed`).
- Permission reviews survive background refreshes; changed access requires a new
  review. Pairing retries the same request after network interruptions and can
  reopen the browser without starting over. Successful account changes are no
  longer treated as failed when the following refresh fails.
- The editor offers browser-local recovery of unsaved note edits after a restart,
  with explicit restore/discard choices and seven-day retention. Full-text content
  loads on demand for search and backlinks instead of at collection startup.
- Desktop collection creation uses the shared keyboard-accessible dialog and
  keeps errors inside it. Collection-row failures stay beside their controls;
  folder-opening failures are no longer ignored. Synced-folder conflicts now
  offer exact Markdown comparisons or binary metadata before choosing a winner.
- The desktop app's connection status no longer freezes behind a slow
  refresh: each source refreshes on its own, so a hosted-collection snapshot
  that takes up to 30 s cannot hold "Connecting securely…" on screen. Pairing
  requests to the server time out after 10 s with an error instead of waiting
  indefinitely.
- Hosted Obsidian Base views work again in collections whose tasks link to
  other notes without an extension, after TaskNotes' setup added `base` as a
  record extension. mdbase-rs `7bd18f1` (0.4.0-rc.6) records the extension
  lookup that actually matched such a link, so its resolution evidence
  validates; before this, every Base view reaching a linked record failed
  with "Obsidian Base evaluation requires a current, integrity-bound
  projection". The engine version change rebuilds hosted projections.
- Approving an application for a large local collection no longer times out.
  Collection setup plans from configuration, locks and definitions alone and
  never copies or validates every record, so assessing it takes milliseconds
  at any collection size. Approval sets up the application's complete
  declaration (every type pack the approval screen lists), so the application
  no longer asks for a second setup review on first open, and approving again
  writes nothing when setup is already current. On a synthetic 30,000-note
  TaskNotes collection, first approval fell from 17s to 3.5s, approving again
  from 22s to under 0.1s, and each application start's setup check from 4.8s
  to 0.03s; the 21s second review is gone. A setup review now depends only on
  the setup inputs, so editing notes while it is open no longer makes it
  stale. The
  unused `baseline_diagnostic_count`, `final_diagnostic_count`,
  `resolved_diagnostic_count`, `introduced_diagnostic_count` and
  `baseline_diagnostic_digest` assessment fields (and their SDK
  `CollectionSetupAssessment` counterparts) are removed.
- Hosted collections store Obsidian Bases as records once collection setup
  adds `base` to `record_extensions`, as local collections do. Setup converts
  each existing Base view resource into a typed record with its exact
  document, and `list_views` and `execute_view` include Base and saved-view
  records whose types implement `obsidian.base` or `mdbase.view`. Before this,
  a hosted Base could not be read or edited with the record operations after
  that setup, and a Base created as a record was not listed.
- Applications may require and add `md` or `base` to a collection's
  `settings.record_extensions` during collection setup (mdbase-rs `1c6290c`),
  so an application can store Obsidian Bases as records. It is the one setup
  target outside an `x-*` namespace, and it is shown in setup review like any
  other change. Connectors advertise `yaml-document-records-v1`, and the server
  asks for a connector update before activating an application that adds
  `base` records on a connector that would read them as Markdown.
- Mirrors materialize Obsidian Bases stored as YAML document records
  (`.base`) alongside Markdown notes, and read each record in the format its
  extension fixes. The mirror's record extensions remain fixed product policy
  that collection configuration cannot extend.
- Saved views are records whose type implements the `mdbase.view` contract
  (mdbase-rs `0d96ad4`, spec `1e147ca`), not records named or typed `view`.
  Applications that save views provision the `mdbase.view` pack during
  collection setup and write views with ordinary record permissions.
  `type: view` records with no implementing type are no longer listed or run
  until the pack is installed. Single-record writes also work again after
  installing a pack whose schemas live outside `_schemas/`.
- Hosted canonical views page while the projection is being rebuilt after a
  definition change, instead of failing with a provider error (provider
  migration 44).
- The Editor's interface text is at least 11px, the outline button sits with
  the note bar's other controls, and pane controls are distinct.
- The Editor's "Your person record" panel explains when the Editor was not
  approved to read your account identity (grants approved before portable
  people record no People permissions) and offers to review the Editor's
  access for the collection, instead of a retry that could not succeed.
- When collection setup needs type-pack review, the error names the conflict
  (for example "_types/task.md: Seed upgrade conflicts with customized
  setting …") instead of "the type pack requires review".
- Collections use mdbase-rs `88d4a21`: a type pack defers to another pack that
  manages identical bytes for the same file, so mdbase Reader and mdbase
  writer can both be set up on one collection.
- Added portable people. An application can declare
  `people: { version: 1, required?: [...], optional?: [...] }` in its manifest
  to ask for `identity` (the signed-in account's name and a stable
  `issuer`/`subject` pair) and `members` (the collection's members). The
  approval screen lists these separately, `members` starts unticked, and the
  grant records exactly what was approved. Subjects come from a new per-account
  `public_subject` (`acct_…`), never an internal id, and the issuer is the
  deployment's configured `MDBASE_CONNECT_IDENTITY_ISSUER`, which Connect now
  requires outside loopback development. Existing grants carry no people
  permissions; applications that declare them are reapproved.
- The SDK adds `connection.people.current()`, `members()` and `directory()`.
  `directory()` reads every record implementing `mdbase.person` 2.0.0 and
  resolves the current account to `linked`, `unlinked`, `ambiguous` or
  `invalid` by exact issuer and subject; other records refer to a person by
  link. `QueryRecord.values` is now declared.
- The Editor can link your account to a person record from Settings, choosing
  an existing contact or creating a note, and sets up person records in a
  collection only after you review the exact definition files.
- Collections use mdbase-rs 0.4.0-rc.5, which implements mdbase spec
  v0.3.0-rc.4. Expressions are standard CEL: `note.` and `present.` are gone
  (use `record.` and `has()`), selecting a field of null is an error (use a
  null check or optional selection such as `a.?b.orValue(null)`), dates are
  `YYYY-MM-DD` strings, and `lower()`/`upper()` fold case. Links read from
  `this` or from `asFile()` resolve relative to their own record, and
  `file.links` holds alias-free link values. Hosted updates send `patch`; the
  `fields` alias is rejected. Stored semantic projections move to format 7.
  New collections write `settings.validation` (template revision 3).
- Hosted collections stay available when the provider moves to a new semantic
  engine. Queries on a collection still indexed by the previous engine run on
  exact fallback, and writes unbind that index instead of failing with
  `projection_engine_mismatch`, so a previous provider still serving during a
  rolling deploy treats the collection as unindexed. Background recovery leaves
  these collections for the new `mdbase-hosted-projection-indexer upgrade`
  command, which rebuilds each one once the previous provider has stopped and
  binds the new index atomically. Recovery also abandons an unfinished rebuild
  left by a provider on another engine instead of stopping on it.
- Added record sessions for editing a record while people type:
  `connection.records.open(path)` returns a session shared by every view of
  that record. It autosaves after a pause, never runs two writes for one
  record, sends only changed frontmatter keys and the body, and reports a
  conflict only when another change touched something edited locally. A save
  whose response was lost is recovered exactly, including after a reload, and
  `connection.records.follow(watch)` keeps open records current through
  changes, renames, deletions and change gaps. See
  [Record sessions](docs/record-session.md).
- `@mdbase-dev/connect-testing` adds `createRecordTestAuthority()`, an
  in-memory authority for testing record editing: revision checks, a change
  watch, edits, renames and deletions from other clients, lost responses and
  refused writes.
- Local collections now report a stale `ifRevision` as
  `concurrent_modification`, a missing record as `file_not_found` and an unsafe
  path as `invalid_path`, as hosted collections already did. These were
  previously `operation_invalid`; code matching on that for these conditions
  must switch to the specific codes.
- Encrypted requests and responses are encoded and decoded in chunks: a 1 MB
  update takes 140 ms instead of 188 ms and a 1 MB read 32 ms instead of 74 ms
  in the browser write profile (`pnpm profile:writes`).
- Local saves no longer rescan the whole collection after each atomic write,
  so a small browser update takes about 30 ms instead of 50 ms at 1,000
  records, and runtime saves at 5,000 records take 44 ms instead of 158 ms.
- Fixed local creates and updates restarting generated `sequence` fields from
  their start value and duplicating values already in the collection.
- `usage report` now reports hosted users from the hosted provider (previously
  always 0), a consent breakdown by authorization flow and by distinct
  application installation, and weekly signup-cohort retention.
- Added the operator `usage report` command: activation funnel, beta
  conversion, pairing and consent outcomes, collection mix, transport use, and
  per-application usage as aggregate counts from existing control-plane rows.
  See [Usage report](docs/usage-report.md).
- Local collections now record their registration time (migration
  `0033_collection_created_at`); existing rows remain unknown.
- The Connect server deletes protocol usage counts, expired tokens, and
  unfinished pairing and authorization requests 395 days after they stop
  mattering to authorization.

## 0.1.0-beta.107

- Fixed Windows startup failing with `Unexpected token 'S'` when Task Scheduler
  success messages were mixed into the connector's JSON response. Thanks to
  @shonatiger for reporting this in
  [TaskNotes #2350](https://github.com/callumalpass/tasknotes/issues/2350).
- PostgreSQL connection failures are contained at both idle-pool and checked-out
  client boundaries, preventing an idle-transaction timeout during hosted
  provider I/O from terminating the Connect process.
- Failed checked-out clients are discarded even when a fatal query response
  races the socket-close event; failed transactions remain rolled back and are
  never retried or reported as successful.
- Real PostgreSQL coverage verifies process survival, rollback, CORS-preserving
  HTTP failure, idle-client termination, active-query termination, and recovery.

## 0.1.0-beta.105

- Durable notification timers now use the stable `notification-timer` source
  identity instead of the surrounding Connect release version, so compatible
  upgrades no longer strand scheduled notifications.
- Hosted migration 43 and the matching local migration rewrite only known
  beta.27–beta.104 timer identities with the exact compatible contract. Unknown
  identities remain rejected, active hosted claims block migration, and expired
  claims are fenced before recovery.
- Notification recovery no longer reports success while overdue timers remain
  leased, and privacy-bounded diagnostics expose only allowlisted runtime error
  stages and categories.
- Hosted provider schema 43 is forward-only: beta.104 must not be restored over
  a migrated database. Staging and production require the registered 42→43
  transition and forward-recovery qualification.

## 0.1.0-beta.104

- Local daemon mutations now retain a durable owner and settle completion claims,
  preventing successful CLI batches from exhausting runtime transaction capacity.
- Interrupted local preparations and completed writes reconcile before the next
  mutation; application and relay replay boundaries remain unchanged.
- `mdbase connect collection recover-writes <collection-id>` previews retained
  writes and supports explicitly selected, independently verified local recovery.
  It preserves application-owned, unsettled and revision-mismatched transactions.
- Local authority state advances to schema 5. Older daemons reject upgraded state;
  restarting alone does not recover historical orphaned claims. See
  [local write recovery](docs/local-write-recovery.md).

## 0.1.0-beta.94

Beta.94 replaces type-scoped application grants with explicit collection-level
authorization and strengthens release compatibility gates.

- Applications request and receive one canonical full-collection scope while
  operation, file, origin, proof-of-possession, and collection boundaries remain
  independently enforced.
- Existing scoped grants, tokens, hosted replicas, and notification authority
  retire fail closed and surface an actionable reauthorization outcome rather
  than being silently widened or reported as corrupt state.
- Local and hosted execution reject legacy scope at every admission boundary;
  exact terminal hosted mutation replay remains available only to still-valid
  retired credentials and cannot authorize changed or new work.
- Authorization approval compensates retained provider policy changes if the
  control-plane transaction fails, revoking the replica when restoration cannot
  be proved.
- Immediate-predecessor persisted-state CI attempts a candidate write before
  projection normalization, runtime diagnostics compare persisted projections
  with the running engine, and release tooling blocks undeclared projection
  format or semantic-engine transitions.
- A live projection-cutover lease admits semantic queries while canonical,
  synchronization, file, import, and provider-control writes remain fenced.
- Exact Editor qualification preserves immediate revalidation on immutable
  Pages assets while separately verifying the canonical domain's bounded,
  managed four-hour policy for edge-cache-eligible asset classes.

## 0.1.0-beta.93

Beta.93 consolidates collection semantics behind typed, capability-bound
runtime APIs and completes cross-platform authority safety.

- Local and hosted reads, queries, mutations, batches, and runtime receipts now
  share canonical typed outcomes while preserving exact v0.3 wire behavior and
  durable replay.
- Collection snapshots are fallible and deterministic; merged-spec resolution
  uses one Unicode-aware, target-filtered ranking contract with bounded
  selection evidence.
- Every post-open filesystem operation, watcher rescan, cache decision, and
  publication remains bound to the acquired collection authority instead of
  reacquiring an ambient display path.
- Capture, cancellation, journal recovery, and compatibility seams are bounded,
  checked, authenticated, and covered by enforceable retirement inventories.
- Unix and Windows publication is capability-relative and atomic. Windows uses
  destination-replacing handle-relative rename, delete-sharing readers, and
  bounded sharing-denial retries without a remove-then-rename fallback.
- Hosted mutation receipts and exact journal replay report the authoritative
  persisted database mtime rather than temporary staging metadata.

## 0.1.0-beta.92

Beta.92 restores relay compatibility with signed beta.90 connectors while
preserving the stronger policy-freshness lease as an optional beta capability.

- Relay policy negotiation now selects explicit `lease_v1` or frozen
  `legacy_ack_v0` behavior; beta.90 receives its original policy wire shape and
  acknowledgement revision without claiming bounded offline revocation.
- Lease negotiation and acknowledged adoption are durable and monotonic, so a
  concurrent, failed, or incomplete attach cannot reopen legacy admission after
  a connector has crossed either boundary.
- Initial and changed-policy acknowledgements fence routing and publication;
  stale mutation responses surface an unknown outcome instead of publishing
  through superseded authority.
- Advisory replacement broadcasts now use a bounded broker flush, so a stalled
  broker acknowledgement cannot prevent the initial policy from reaching an
  otherwise authenticated connector session.
- Connector-side lease adoption remains sticky, partial lease metadata fails
  closed, and websocket shutdown aborts the policy coordinator before it can
  restore a disconnected session to `Connected`.
- Account surfaces truthfully recommend updates for legacy acknowledgements and
  retain beta.91 as the lease capability floor while the baseline connector
  floor remains independent.
- `policy-freshness-lease-v1` stays optional for every beta. Stable `v0.1.0` is
  only the earliest possible enforcement boundary and remains subject to the
  documented production-observation and rollback gates.

## 0.1.0-beta.91

Beta.91 hardens collection ownership, filesystem convergence, and authorization
revocation across the Editor, local connector, hosted provider, and mirrors.

- Editor collection transitions freeze and drain owned work before changing
  authority, fence stale publication, isolate transclusions, and keep detached
  type-definition saves generation-safe.
- Watcher and mirror paths preserve typed invalid-record outcomes, capability-
  bound filesystem reads, exact cache acknowledgement, bounded retry state, and
  feed silence for invalid private observations.
- Hosted authority imports, mutation recovery, account snapshots, selected-folder
  scopes, and exact timer reconciliation now retain their execution-time
  authority and fail closed under contention or stale completion.
- Connector policy leases use exact-session acknowledgements, bounded renewal,
  cross-instance coalescing, and transport-bound publication fences so revoked
  work cannot publish through a successor policy.
- Release tooling can bind an exact signed candidate, client, and Editor revision
  to guarded LAB-only deployment and rollback evidence without permitting a
  staging or production target.

## 0.1.0-beta.90

Beta.90 makes account deletion transactional, isolates stale hosted grants, and
extends the production canary through application registration.

- Account deletion revokes local capabilities and commits the user teardown in
  one transaction before durable, retryable provider cleanup begins.
- Cross-account replicas, failed local transactions, transferred authorities,
  provider outages, and duplicate cleanup delivery are handled explicitly.
- Confirmed missing provider collections are quarantined locally; their grants,
  tokens, replicas, and pairing requests fail closed without conflating
  ownership conflicts or transient provider failures.
- One confirmed-missing grant no longer blocks another account from registering
  the same application, while ownership conflicts remain visible failures.
- The hosted-read canary now registers the exact portable CLI application before
  authenticated describe, marker read, and digest verification.
- `MDBASE_CONNECT_ACCOUNT_DELETION=disabled` retains a fail-closed operational
  hold for future incident response.

## 0.1.0-beta.89

Beta.89 temporarily pauses account deletion while the hosted deletion workflow
is corrected.

- Account deletion fails closed after same-origin and session authentication,
  without consuming reauthentication tokens or changing account state.
- The account surface explains that deletion is temporarily unavailable.
- Hosted provider data and credentials are never mutated by a blocked request.

## 0.1.0-beta.88

Beta.88 improves the editor's loading continuity, navigation, and feedback.

- Loading skeletons align with the editor surface on desktop and mobile.
- Note lists gain grouped headers and accessible arrow-key navigation.
- The editor adds word counts, document outlines, action-palette commands,
  unified toasts, and smoother preview transitions.

## 0.1.0-beta.88

Beta.87 makes local multi-collection discovery fast and resilient and corrects
editor authorization redirects.

- Local collection listing is metadata-only, while authorization descriptions
  use read-only resource snapshots without opening record runtimes.
- Catalog discovery isolates malformed collection resources, reuses one catalog
  per authorization offer, and preserves fresh authorization checks at the
  connector boundary.
- Notification recovery keeps idle and future work cold, opens runtimes only for
  actionable persisted work, and rechecks collection authority before dispatch.
- Relay inventory synchronization is single-flight, and high-frequency runtime
  finalization is bounded to resident enabled collections.
- Editor authorization now preserves valid same-origin return targets and uses
  the correct production editor fallback.

## 0.1.0-beta.86

Beta.86 opens verified public password signup and makes non-production Connect
environments explicit and isolated.

- Public signup verifies email ownership before accepting a password, preserves
  same-origin authorization return targets, rate-limits requests and token
  redemption, and avoids revealing whether an account already exists.
- New public accounts receive the permanent open-beta entitlement, including
  1 GiB hosted storage and three hosted collections, plus a starter collection,
  legal agreement records, and a signed-in browser session atomically.
- Account creation claims canonical verified emails across password, invitation,
  and external-provider flows so concurrent signups cannot create duplicate
  owners without authenticated account linking.
- Invitation signup retains its original ten-collection beta allowance while
  registration is open, and the retired beta-access request endpoint no longer
  stores submissions.
- Server health identifies the deployment environment, while editor and desktop
  tooling reject mismatched lab, staging, and production endpoint combinations.

## 0.1.0-beta.85

Beta.85 makes SDK startup explicit and turns application declaration drift into
a safe, recoverable reauthorization flow.

- **Breaking:** `MdbaseApplicationSession` replaces `opening` with explicit
  `not_started`, `starting`, `start_failed`, and terminal `destroyed` lifecycle
  snapshots. `start_failed` carries the original typed problem and `start()`
  retries it.
- **Breaking:** lifecycle-dependent async methods now resolve typed lifecycle,
  timeout, and cancellation outcomes while sharing an in-progress startup
  budget. `select`, `clearSelection`, and `forget` return lifecycle-aware
  `ConnectOutcome` values. Provisional startup returns `session_starting`, and
  failed startup methods reuse the exact `start_failed.problem` object.
- Saved grants bound to a previous registered application identity now surface
  `application_declaration_mismatch` as `authorization_required` before setup
  checks. Migration requires an explicit `authorize("selected")`; Connect
  preserves pending mutation recovery and does not replay it automatically.
- Grant-key rotation preserves in-flight and durable mutation recovery across
  browser contexts, then removes retired key material only when it is safe.
- The editor gates collection actions on successful startup and provides an
  explicit retry path for recoverable startup failures.

## 0.1.0-beta.84

Beta.84 tightens hosted operation correctness and enables Obsidian Base views
for newly created hosted collections.

- Fresh hosted collections provision `views/**/*.base` alongside canonical
  Markdown sources, with aligned Rust and TypeScript template semantics.
- Hosted entitlement reconciliation is resumable, idempotent, and protected
  from overlapping operator batches.
- Background sync can acknowledge reviewed plans it already completed while
  retaining pending recovery and stale-plan protections.
- Hosted operations reject unknown or mistyped inputs, preserve authoritative
  persisted mutation outcomes, and distinguish safe rejection from uncertain
  non-JSON responses.
- CLI and server authorization now align owner-only batch and timer operations
  with generated protocol metadata.
- Control-plane availability reports transport reachability without masking
  malformed protocol responses or structured authorization failures.
- The hosted provider uses mdbase-rs revision
  `4f861ba14b685e952ed7e7be869e3980a9eda613` so canonical Markdown views are
  classified and committed as resources through the single-writer runtime.

## 0.1.0-beta.83

Beta.83 makes Connect onboarding and collection management simpler and more
consistent across browser applications, the desktop client, and the portal.

- Account-first onboarding now carries the user's intent through pairing,
  explains existing-folder setup, and ends with durable collection receipts.
- Applications can opt into a focused popup authorization flow with redirect
  fallback, isolated-window recovery, and in-place completion in the original
  application session.
- Reauthorization clearly separates existing access from newly requested
  actions, while grant editing remains limited to narrowing or revoking access.
- Authority transfer uses one consequential approval with readiness, progress,
  application and replica impact, completion, and retired-authority history.
- Desktop, Connect management, and transactional approval terminology now
  distinguishes durable configuration from individual data operations.
- Windows release qualification now compares canonical repository content so
  Git's CRLF checkout conversion cannot block an exact qualified commit.

## 0.1.0-beta.82

Beta.82 keeps hosted saved views usable when an ordinary Markdown record cannot
be parsed completely.

- Hosted Obsidian Base evaluation now omits semantically incomplete candidate
  and related records after first verifying their projection integrity. One
  malformed frontmatter document therefore no longer aborts every readable row
  in the view.
- The successful view response includes a `hosted_base_record_skipped` warning
  so applications can explain the omission without exposing record paths from
  contract-scoped collections. Stale or integrity-invalid projections,
  incomplete required query context, and structural resource failures remain
  fail-closed.

## 0.1.0-beta.81

Beta.81 permits applications to work with collections containing records that
do not yet satisfy their schemas.

- Application setup and direct type-pack installation no longer reject an
  otherwise structurally valid collection because installing the types exposes
  record-schema violations. Setup assessments continue to report baseline,
  final, introduced, and resolved diagnostic counts.
- Hosted saved views can evaluate the parsed frontmatter of schema-invalid
  records without failing the whole view. The records retain their validation
  diagnostics, while malformed frontmatter, malformed relationships, and
  body-dependent projection gaps remain fail-closed.

## 0.1.0-beta.80

Beta.80 fixes type-pack updates that rename a resource's source while retaining
the same installed target.

- Type-pack retirement planning now treats an installed target as owned by the
  desired pack even when its source path changed. Previously the planner could
  adopt the resource from its new source and then retire the same target under
  its old source receipt. For packs containing an exact data contract, that
  removed the contract after adopting it and left implementing types invalid.
- The fix preserves the desired target and retires only resources whose targets
  are genuinely absent from the desired pack. A regression test covers renamed
  schema, contract, and seed sources, including collection reopen validation.

## 0.1.0-beta.79

Beta.79 fixes a durable write race in the engine and a credential expiry that
never decoded.

- The runtime transaction commit path now rejects a commit against a path
  another commit owns but has not settled. Settlement runs after the commit lock
  is released, so a committed-but-unsettled transaction was invisible to the
  precondition check and two writers could both take commit points against one
  baseline. Whichever settled second found a revision matching neither its
  before nor its intended state, stranded its journal as needing manual
  recovery, and that journal then failed every later collection open — so an
  ordinary lost write race could leave a collection unopenable. The loser is now
  rejected before taking a commit point, reporting a concurrent modification
  conflict, which is what it is.
- `storage.credential_expires_at` in the hosted provider diagnostics surface
  reported no expiry for every temporary credential. The session token is
  standard base64 of `jwt/<header>.<claims>.<signature>` rather than a bare JWT,
  so its claims were never read and an expiring credential was indistinguishable
  from a permanent one. That is the field the surface exists to provide, and it
  failed in the direction of false reassurance.

Note for operators: a modest increase in concurrent modification conflicts is
expected and correct. Races that previously succeeded and then stranded now
surface as conflicts instead. A sustained rate against a small set of paths is
the signal worth investigating, not the aggregate change.

## 0.1.0-beta.78

Beta.78 adds a diagnostics surface to the hosted provider.

- `/internal/v1/diagnostics` reports projection readiness by cause, durable
  projection checkpoints, drain state, the applied migration ledger, storage
  configuration including credential expiry, and recent resource changes. Like
  the existing query-activity route it is internally authenticated and bypasses
  admission, so it answers while the provider is fenced.
- Each section is separately bounded and separately fallible: a slow database
  yields one unavailable section rather than an unanswerable request. The
  payload is versioned, and every section is aggregate-and-identifier only, so
  no record content, frontmatter, body prose or key material is exposed.
- Two reviewed read-only SQL files ship in the provider image for row-level
  forensic detail where the aggregate surface is not enough.

## 0.1.0-beta.77

Beta.77 fixes a hosted-provider outage in which saving an Obsidian Base source
took the whole provider offline.

- Resource mutations advance the collection resource revision, but the
  projection catalog binding was invalidated only for type mutations. A view
  mutation left the active generation pinned to a superseded revision with no
  rebuild scheduled, stranding the collection permanently stale. A Base source
  is a query definition and no projected fact derives from it, so the generation
  is now carried to the new revision; type mutations still invalidate.
- Readiness no longer fails when a collection's projection is absent or
  rebuilding. Such a collection is served from bounded canonical exact fallback
  by design, so `/ready` now reports `projections.degraded_collections` instead
  of returning 503 and withdrawing a provider that is serving correctly.
- The Pickle SDK gains a `pickle_attachment` type and
  `PickleCollection.readAttachment`, advancing its type pack to 1.1.0.

## 0.1.0-beta.76

Beta.76 separates derived-state integrity verification from semantic exact
fallback. A fully verified generation may contain records that mdbase-rs marks
semantic-incomplete; query initialization detects those rows independently and
keeps them on bounded canonical exact evaluation. This preserves both the final
cutover integrity gate and complete query results.

## 0.1.0-beta.75

Beta.75 allows a projection generation to activate when a canonically parsed
record intentionally requires exact fallback, while continuing to require
complete relationship resolution and valid projection digests. This prevents
the production cutover indexer from repeatedly rebuilding collections that
contain malformed Markdown or body-dependent computed fields. Query execution
still treats those rows as projection-incomplete and uses bounded exact fallback;
authorization classification remains fail-closed.

## 0.1.0-beta.74

Beta.74 replaces the unreleased Candidate B migration history with the final
single-runtime upgrade from the production beta.69 schema. Encrypted exact
Markdown remains authoritative; PostgreSQL stores only the accepted readable,
rebuildable semantic projection and bounded relationship graph.

- Hosted migrations 0035 and 0036 now create the complete final projection,
  cursor, receipt, integrity, admission, and indexing contracts directly from
  beta.69 migration 0034. Transitional execution modes, cursor proofs, digest
  shapes, receipt encodings, and staging-only upgrade gates are absent.
- Every active collection requires a current projection binding. New
  collections and imported authorities remain hidden while the resumable,
  fenced indexer builds and verifies their first generation; existing exact
  authorities retain bounded canonical fallback during cutover recovery.
- Ordinary query, validation, saved-view, Base, and mutation paths no longer
  materialize a collection-wide WorkingSet. Closed SQL plans provide
  snapshot-pinned keyset pages, bounded residual work, typed budget outcomes,
  and canonical `file.inFolder(...)` semantics without decrypting body prose.
- The hosted-provider image includes audited `plan`, `apply`, `status`, and
  `verify` commands for an all-collection maintenance-window backfill. Exact
  beta.69 rollback and forward-rebuild procedures preserve canonical records,
  versions, resources, changes, journals, receipts, files, and outbox state.

## 0.1.0-beta.73

Beta.73 makes Candidate B activation safe for isolated staged rollout while
leaving production and all existing collections on their prior execution model.

- New hosted collections can opt into Candidate B only through a versioned,
  capability-checked protocol. A durable pending intent leaves legacy routing
  unchanged until a fully resolved generation is atomically bound to the exact
  authority head and resource revision.
- Projection work remains bounded to one fenced batch per provider call. Large
  authority imports return an explicit resumable `202 activating` outcome after
  each control-plane work allowance instead of exposing a partial collection or
  turning expected continuation into a terminal failure.
- Restart recovery resumes pending generations, exact lost responses reconcile
  only the named generation, and terminal semantic or ciphertext failures are
  quarantined against the same authority/catalog/engine binding.
- Concurrent hosted mutations use deterministic collection-before-replica lock
  ordering, closing the staging deadlock found by the live mutation mission.
  Activation status is snapshot-consistent and reports only bounded operational
  metadata; exact Markdown and body prose remain application-encrypted.

## 0.1.0-beta.72

Beta.72 completes the Candidate B hosted execution architecture behind its
explicit per-collection rollout gate. Exact Markdown remains application-
encrypted and authoritative; PostgreSQL stores a rebuildable, provider-readable
semantic projection and bounded relationship graph generated by `mdbase-rs`.

- Hosted queries now use closed versioned plans, deterministic snapshot-pinned
  keyset pages, bounded ordering/grouping, typed scan/byte/operator/time budgets,
  and prompt database/permit/plaintext cleanup on cancellation without a silent
  collection-wide WorkingSet fallback.
- Exact reads and all point mutations remain revision-CAS protected. Durable
  receipts, transactional projection/relationship updates, stale-projection
  canonical fallback, rebuild leases/fencing/checkpoints, and fail-closed
  authorization recovery cover ambiguous outcomes and restarts.
- Structurally significant body facts—including wikilinks, Markdown links,
  embeds, tags, aliases, anchors, relative targets, and ambiguity evidence—are
  projected without exposing body prose. Narrow identity, cursor, and graph
  indexes are retained; no general projection GIN is added.
- Additive hosted migrations, guarded projection and receipt invariants,
  rollback preflights, observability, deterministic 10k/100k/high-cardinality
  evidence, and isolated-consumer rollout procedures prepare the architecture
  for staged activation. Existing collections remain on their prior execution
  model until explicitly migrated.

## 0.1.0-beta.71

Beta.71 begins the bounded hosted execution rollout and adds direct hosted CLI
access without weakening the encrypted authority boundary.

- The unified CLI can authorize a direct, per-collection hosted connection and
  execute portable data commands against the hosted authority without a local
  filesystem mirror. Hosted requests use short-lived provider capabilities,
  grant-bound P-256 proofs, automatic credential refresh, and the same explicit
  revocation model as other applications. Account login alone still cannot read
  collection contents.
- Hosted point reads now fetch and decrypt exactly one record by stable identity
  or keyed path token, compile canonical resource semantics through `mdbase-rs`,
  and avoid the legacy collection-wide decrypted working set.
- A published execution-budget manifest, privacy-safe memory and scan metrics,
  deterministic large fixtures, and temporary working-set admission limits make
  the remaining compatibility path explicit and bounded during migration.

## 0.1.0-beta.70

Beta.70 lets browser extensions complete the device-code authorization flow
without weakening the exact-origin capability boundary.

- Device authorization records the initiating Chrome or Firefox extension
  origin and binds local and hosted grants to that exact origin. Native clients
  retain the existing opaque `null`-origin behavior.
- Existing extension grants can be reauthorized once to receive the corrected
  origin-bound capability.
- Dependency resolutions move Nano ID to 3.3.18 and replace the vulnerable
  `extract-zip` release with Electron's maintained API-compatible fork.

## 0.1.0-beta.69

Beta.69 makes retained writable mirrors durable across adoption and remote
renames, and finishes the current editor query and PDF hardening.

- An already-identical writable folder now seeds records, collection resources,
  and binary descriptors into its first durable checkpoint. A retained mirror
  no longer attempts to re-upload the authority snapshot it just adopted.
- Applying a remote record rename updates both the mirror entry and its retained
  writable record payload, so the next restart or inspection remains valid.
- Contract-scoped queries support generation-pinned cursor pagination, and the
  editor serves its PDFium runtime and viewer dependencies from its own build.

## 0.1.0-beta.68

Beta.68 keeps the desktop control plane responsive when the operating-system
credential store is temporarily unavailable.

- Desktop refreshes are single-flight, so timer and user-triggered refreshes
  share one bounded request instead of multiplying concurrent control work.
- A locked or unavailable credential store is represented as a typed offline
  hosted snapshot. Repeated hosted polls are served locally for a 30-second
  retry window, while unrelated failures remain visible.

## 0.1.0-beta.67

Beta.67 restores hosted-authority query compatibility while keeping
generation-pinned cursor pagination as the preferred SDK path.

- The SDK now treats its first automatic cursor request as a read-only
  capability probe. If an authority rejects the optional pagination field, it
  retries that first page with legacy offset pagination and keeps later pages
  on the legacy path.
- Explicit cursor requests remain strict: they are never silently downgraded,
  so callers asking for generation-pinned semantics still receive the
  authority's typed incompatibility response.

## 0.1.0-beta.66

Beta.66 hardens the coordinated runtime introduced in beta.65 against
non-semantic filesystem churn, removed-collection races, and recoverable object
storage rejection during multipart upload.

- The provider classifies watcher events before reconciliation. Hidden files,
  cache and migration paths, configured exclusions, disabled subfolders, and
  non-record binaries no longer rebuild a large collection snapshot; metadata,
  schemas, contracts, and record resources retain exact reconciliation.
- Watcher snapshot loading is side-effect-free, leaving durable transaction
  recovery with the coordinated runtime instead of racing settlement on an
  observer thread.
- Collection removal now crosses a synchronous watcher lifecycle barrier before
  registry deletion, while failed refreshes restore active state. Mirror
  residency owns at most one abortable worker per replica and cancels it when
  the replica is no longer actionable.
- Multipart object uploads retry transient or authorization failures with a
  fresh presigned URL for the same idempotent part number. Invalid progress
  reports privacy-safe state and counts instead of opaque payload data.

## 0.1.0-beta.65

Beta.65 makes one coordinated mdbase runtime the local execution owner for
each active collection and removes the duplicate Connect watcher and mutation
invalidation paths.

- The provider now returns exact generation-bound execution outcomes, owns
  durable prepare/commit/cancel settlement and a pull/ack change feed, applies
  sparse record mutations, and maintains its rebuildable cache and reverse-link
  index incrementally.
- Connect gives each resident collection separate bounded mutation,
  foreground-read, and background lanes. Known mutations and external edits
  enter one durable ordered change path, and post-commit work remains owned
  after the caller's deadline.
- Runtime residency is bounded to eight idle/active collection handles;
  inactive runtimes can be evicted and reopened from canonical Markdown without
  changing collection identity or grants. Privacy-safe diagnostics expose only
  aggregate resident state and retained snapshot bytes.
- The SDK coordinates requests once per selected connection, keeps a reserved
  ordered mutation lane, bounds foreground pressure, coalesces only safe reads,
  and supports explicit latest-wins query families.
- Query iteration uses opaque generation-pinned cursors when supported, releases
  cursor leases on early exit, and retains the legacy snapshot/offset path for
  older staging-compatible authorities.
- The hosted mirror transport has bounded connect, read, and whole-sync
  deadlines so a stalled binary transfer releases its mirror guard and resumes
  through durable journal recovery.

## 0.1.0-beta.64

Beta.64 keeps large local and relayed collections inside one explicit resource
boundary while preserving foreground and durable-mutation capacity under load.

- Local control, encrypted loopback, and relay operations share bounded
  admission and stable collection-read workers; foreground, background, file,
  and mutation work retain independent global and per-grant limits.
- Read capacity remains held through serialized response delivery, preventing
  slow WebSocket, loopback, or local-socket consumers from multiplying large
  retained bodies after execution has nominally completed.
- Cooperative read cancellation observes deadlines between bounded engine,
  sync, inventory, and file phases. Timeout and durable mutation entry meet at
  one atomic boundary so `not_sent` remains provable and post-boundary work is
  recovered by exact request replay.
- Idempotent upload-open and transfer-abort housekeeping no longer scans the
  complete collection for mutation evidence; collection-changing file
  operations retain manifest evidence.
- Upload-open replay safely recovers an empty regular staging file left by a
  crash before transfer-row insertion and rejects unsafe or non-empty orphans.

## 0.1.0-beta.63

Beta.63 makes execution deadlines truthful for durable mutations and preserves
their exact recovery identity across every SDK transport outcome.

- A relayed or direct durable mutation that outlives its caller's execution
  deadline now returns `operation_outcome_unknown` instead of the incorrect
  `operation_cancelled` / `not_sent`; queued work and reads retain their
  cancellable `not_sent` semantics.
- The SDK retains pending mutation state when either an HTTP authority response
  or an encrypted connector receipt reports an unknown outcome, then recovers
  with the same request ID, counter, ciphertext, operation, and payload while
  refreshing only the unauthenticated scheduling deadline.
- SDK-side deadlines after mutation dispatch also become unknown outcomes,
  while pre-dispatch cancellation remains definitively `not_sent`.
- Aborted framed file downloads preserve typed `operation_cancelled` results
  even on runtimes that surface an aborted fetch as `TypeError`.

## 0.1.0-beta.62

Beta.62 bounds collection-query memory and connector admission under load while
preserving capacity for interactive reads and mutations.

- Metadata-only typed queries page through the engine cache instead of
  materializing the full collection, and expired queries stop cooperatively
  during cache refresh, snapshot loading, and record evaluation.
- Direct and relayed work share one bounded scheduler with per-grant limits,
  reserved mutation capacity, foreground read capacity, per-collection
  mutation serialization, and count- plus byte-bounded queues.
- SDK requests carry an optional absolute deadline that can only shorten the
  connector's local execution window; it remains outside durable replay
  identity so retry and recovery semantics do not change.
- The control plane bounds pending encrypted operations by grant, connector,
  process count, and retained request bytes while policy and control traffic
  retain dedicated capacity.

## 0.1.0-beta.61

Beta.61 makes hosted-provider readiness acyclic while retaining an exact,
operator-visible account of durable notification recovery.

- Provider readiness now covers only the authoritative database, blob store,
  and key hierarchy; retryable notification callbacks no longer keep Connect
  and its provider waiting on each other or trigger a platform restart loop.
- Startup attempts notification recovery without making callback availability
  a process-start dependency, and the background worker safely replays the
  same durable invocation after the control plane recovers.
- Recovery is single-flight and reports `pending`, `degraded`, or `ok` from the
  actual durable outbox and runtime state, with privacy-safe transition metrics
  and no false healthy result from an overlapping or lease-blocked sweep.

## 0.1.0-beta.60

Beta.60 keeps large local collections responsive while binary files are served
and makes bounded connector backpressure recoverable by applications.

- Opening one indexed download no longer reconciles or hashes the rest of the
  vault; the selected snapshot is still copied and digest-verified before any
  bytes are released.
- Stale paths are resolved with a metadata-only identity scan so authorization
  is rechecked against a file's current path without restoring whole-vault work
  to the request path.
- Connector overload is an explicit `503` with `Retry-After`; the SDK applies
  deadline-bound jittered backoff, reuses exact mutation envelopes, refreshes
  read envelopes, and never retries unknown mutation outcomes.
- File chunks use bounded retry backoff long enough to bridge a desktop daemon
  restart while preserving cancellation and integrity checks.

## 0.1.0-beta.59

Beta.59 makes legitimate large relay operations independent of the broker's
per-message payload ceiling.

- Relay requests and responses use bounded, versioned fragmentation below the
  active NATS `max_payload`, with strict logical-message and aggregate-memory
  limits, assembly deadlines, and malformed-frame rejection.
- JSON operations and opaque binary file frames share the same transport, so
  large collection listings and file traffic cannot terminate a Connect server.
- Multi-instance relay coverage now exercises requests and responses above the
  broker ceiling, concurrency, connector fencing, disconnects, and recovery.

## 0.1.0-beta.58

Beta.58 closes two staging findings from the beta.57 compatibility rollout.

- Connector control snapshots include the exact signed declaration, manifest,
  and protocol contracts required to deserialize and install active grants.
- Cold or changed binary indexes warm once outside the relay request path;
  stable files reuse verified digests, and exact downloads still verify the
  selected bytes before delivery.
- The SDK retries typed index-warming responses under a dedicated file-index
  budget instead of leaving a timed-out relay request hashing in the daemon.

## 0.1.0-beta.57

Beta.57 adds a bounded migration bridge for durable beta.55 work while keeping
transport v3 as the only current request path.

- Authorization binding v5 signs an explicit mutation-only v2 recovery
  contract; ordinary reads and new mutations cannot silently downgrade.
- Frozen beta.55 v4 and transport-v2 fixtures preserve exact interoperability,
  including durable legacy-read receipts across connector restarts.
- Existing hosted replicas expand safely and are reconciled to their exact
  signed transport policy before the compatibility window contracts.
- Privacy-minimal protocol telemetry and fail-closed readiness gates make v2
  and v4 removal depend on observed use and remaining recovery contracts.

## 0.1.0-beta.56

Beta.56 isolates local authorization from application data-plane load and
introduces the coordinated transport-v3 replay contract.

- Policy, grants, admission counters, and mutation recovery move to a bounded
  single-writer `authority.sqlite` store.
- Exact mutation responses use immutable, content-addressed receipt files;
  ordinary read responses remain only in a byte-, count-, and age-bounded cache.
- SDK reads retry once with a fresh encrypted request after route uncertainty or
  cache loss, while mutations retain their exact recoverable envelope.
- Relay policy installation is ordered off the socket loop with bounded queues,
  reserved control capacity, and typed overload responses.

## 0.1.0-beta.55

Beta.55 hardens portal authorization startup, hosted record mutations, and
editor projection consistency.

- Portal auth fragments are captured before the first render.
- Hosted record preflights are separated from mutation execution.
- Editor projections rebase after source saves.

## 0.1.0-beta.54

Beta.54 makes application startup safe for large hosted collections when the
requested collection setup is already current.

- Current setup assessments no longer clone the complete collection into a
  temporary preflight workspace.
- Applicable setup changes still use the existing staged, revision-safe
  transaction path.

## 0.1.0-beta.53

Beta.53 requires application sessions that request full-collection access to
hold a matching full-collection grant.

- Contract-scoped grants no longer satisfy full-collection application
  requirements and trigger renewed authorization.
- Contract-scoped application requirements continue to work with
  contract-scoped grants.

## 0.1.0-beta.52

Beta.52 removes avoidable latency after a file download has already completed
and passed integrity verification.

- Browser clients expose verified file bytes immediately while best-effort
  transfer cleanup continues outside the document-loading critical path.
- Cancellation and failed downloads still wait for cleanup, preserving the
  existing recovery and integrity guarantees.

## 0.1.0-beta.51

Beta.51 improves resilience under local registry contention and reduces file
download latency.

- Relay operations distinguish retryable SQLite contention from rejected
  requests and report that the operation was not sent.
- Connector watchers batch registry writes to shorten transactions and reduce
  lock contention while preserving operation ordering.
- Framed file downloads prefetch subsequent chunks without changing integrity
  verification or retry behavior.

## 0.1.0-beta.50

Beta.50 makes application authorization independent from collection repair and
keeps collection-setup failures actionable.

- Applications that require no collection setup can be authorized even when
  unrelated existing records have validation errors.
- Required setup compares staged diagnostics with the collection baseline,
  preserving existing errors while rejecting errors introduced by the setup.
- Connector diagnostics now survive the relay and appear in the portal with
  their affected collection path while the selected collection stays in place.
- The editor development deployment has a documented, verified staging helper.

## 0.1.0-beta.49

Beta.49 gives new accounts a useful first collection and sends them directly
into the mdbase editor.

- Invitation signup provisions a small hosted starter collection from a
  versioned Markdown template, with an idempotent recovery path if provisioning
  is interrupted.
- The post-signup handoff opens the starter collection in the editor, where its
  notes explain collections and the next ways to build with mdbase.
- Writer mode renders Markdown and wiki links as readable links while preserving
  source editing, and empty type views use a clearer centered state.
- Hosted storage refuses insecure non-local R2 endpoints, and release builds
  reuse Rust and BuildKit caches to shorten beta delivery time.

## 0.1.0-beta.48

Beta.48 adds a safe recovery path for invitations affected by the beta.47
signup incident.

- Managed invitation resends can use a recovery-only transactional template
  that apologizes for the failed signup and delivers the fresh one-time link in
  the same email.
- Recovery resends retain the invitation entitlement, invalidate the previous
  link, omit credentials from operator output, and identify the email template
  in the operator result and audited reason.

## 0.1.0-beta.47

Beta.47 repairs invitation account creation and email delivery tracking for the
invite-only beta.

- Invitation acceptance now locks only the invitation row before creating the
  account, avoiding PostgreSQL's prohibition on locking the nullable side of an
  outer join while retaining single-use invitation semantics.
- Resend delivery webhooks use contiguous PostgreSQL parameters, allowing
  delivery, bounce, suppression, and complaint events to update email state.
- The account creation form no longer suggests connecting Google later.

## 0.1.0-beta.46

Beta.46 separates hosted replica storage allowances and repairs Google account
linking for invited beta accounts.

- Hosted account quotas now distinguish primary hosted collections from local
  replica slots, including independent entitlement limits and migration of
  existing account data.
- Google Identity Services receives the relying-party origin from both Connect
  and Editor, and trusted editor callbacks can complete account linking.
- Invited people create their account through the one-time password link, may
  connect Google afterward, and can use that linked identity for later sign-in
  without opening registration to matching email addresses.

## 0.1.0-beta.45

Beta.45 makes pre-existing application definitions reviewable and completes
the beta.44 application-setup hotfix.

- Collection setup can carry exact, digest-pinned consent to adopt a managed
  definition that already exists without a type-pack receipt. The SDK prepares
  that review automatically, so application update buttons are enabled without
  silently changing the collection.
- Hosted and local approval retry the reviewed setup with those exact digests.
  Files owned by another pack, seed definitions, and definitions changed after
  installation remain conflicts; a change between review and apply is rejected.

## 0.1.0-beta.44

Beta.44 is a managed-service hotfix for application setup and hosted MCP
authority access.

- Application approval now applies the complete setup the user reviewed,
  including managed updates and auxiliary type packs when a collection already
  provides the required contract. The portal names every declared definition
  pack, and the application SDK performs only one initial setup assessment.
- The MCP gateway retains each hosted grant's signing key and signs both
  provider operations and refresh-token exchanges. Hosted collection calls no
  longer fail immediately with a provider 401 or misleading `invalid_grant`.
- Closed-registration login pages link people without an invitation to the
  beta access request page.

## 0.1.0-beta.43

Beta.43 completes the coordinated beta.42 desktop release without changing the
sync protocol or runtime behavior.

- Large, deterministic sync fixtures now use platform-neutral completion
  guards. Exact chunk, download, cache, read, write, and stable-state
  assertions remain the performance contract, while slower release runners no
  longer turn healthy work into wall-clock-only failures.
- The macOS Intel release regression suite and every supported desktop smoke
  test pass with the same plan-only sync engine shipped in beta.42.

## 0.1.0-beta.42

Beta.42 makes native startup deterministic when the operating-system
credential service is locked or slow and completes cross-platform release
verification for the beta.41 sync architecture.

- Credential bootstrap has a strict two-second deadline. An unavailable store
  enters an explicit offline mode that keeps local control responsive, disables
  direct application access, and returns typed errors for secret-dependent
  operations instead of hanging or repeatedly retrying.
- Watcher and relay initialization run as an owned background startup task.
  Local status is immediately available with `ready: false` until initialization
  finishes, and shutdown still cancels the worker cleanly.
- Desktop release portability tests accept native Windows CRLF checkouts while
  preserving the same Rustls provider-ordering assertion on every platform.

## 0.1.0-beta.41

Beta.41 completes the prerelease conflict workflow and the native runtime
hardening found during packaged and live Obsidian testing.

- Writable initial same-object divergence is a durable, nonblocking conflict,
  so independent actions can proceed while path-ownership, read-only, and
  resource collisions continue to fail closed.
- Record and binary-file conflicts now share one entity-aware status and
  resolution protocol. Every choice echoes a semantic decision token and is
  applied only while both the local bytes/path and hosted snapshot still match
  the reviewed conflict; stale choices require a fresh inspection.
- Conflict inspection refreshes changed exact states and clears natural
  convergence through an explicit plan action. File resolution preserves
  stable identity across exact byte changes, moves, and deletions.
- The desktop and native daemon share the same local-control protocol contract,
  and the Rust workspace installs one explicit TLS crypto provider before any
  client construction.

## 0.1.0-beta.40

Beta.40 completes the operational hardening found while upgrading and live
testing beta.39's exact-document sync engine.

- Incompatible prerelease mirror state is identified from its minimal version
  envelope before current-schema decoding, so upgrades fail at the deliberate
  rebuild boundary rather than at an incidental nested field.
- A blocked legacy mirror no longer hides healthy replicas or retries forever;
  list results isolate its structured error and background scheduling waits for
  operator rebuild.
- An exact idle incremental inspection is now a stable empty plan. Applying it
  performs no journal, checkpoint, cache, generation, timestamp, or durable
  state write, while real cursor advances and effectful plans still checkpoint.
- Tag-triggered npm and desktop publishers may be manually rerun against the
  exact existing tag after an Actions outage.

## 0.1.0-beta.39

Beta.39 deliberately rewrites the unreleased sync-v1 contract around exact
documents and one reconciliation owner. Existing prerelease mirrors must be
rebuilt; there is no dual-format compatibility path.

- Record and resource revisions are SHA-256 over exact UTF-8 document bytes.
  BOMs, line endings, comments, key ordering, nulls, malformed frontmatter,
  trailing spaces, and bodies survive authority and mirror round trips.
- Raw replication uses only conditional `put`, `move`, and `delete`. A move
  preserves identity and every document byte and never rewrites references;
  semantic rename remains an explicit mdbase operation.
- TypeScript and Rust mirrors now inspect both sides into a sorted,
  content-free plan, revalidate its fingerprint, and apply one durable batch.
  Obsidian and the native CLI consume that plan instead of calculating another
  preview.
- Expected collisions, conflicts, resource drift, cancellation, and stale
  review are explicit outcomes. Fresh status is inspection-backed, while the
  cheap checkpoint view makes no remote-freshness claim.
- Shared portable-path fixtures cover platform-reserved punctuation and
  physical aliases. Lost replies, restart, byte-odd Markdown, raw moves,
  binary echoes, stale plans, and side-effect-free inspection have regression
  coverage.
- The hosted beta migration retires wrapper-shaped records and replay state
  while preserving collection identity, replicas, resources, files, quotas,
  notification grants, and the shared sequence head. This is the explicit
  prerelease reset boundary, not a hidden dual-format decoder.

## 0.1.0-beta.38

Beta.38 restores correct logical-array semantics for editable Obsidian Bases
saved views. In particular, TaskNotes Today views now interpret their nested
`or` filter correctly and retain date-only tasks scheduled for the current day.

## 0.1.0-beta.37

Beta.37 makes calendar semantics explicit across local, hosted, and application
execution without changing the published protocol-version constants.

- Queries and saved-view executions accept an ephemeral IANA timezone, and the
  SDK carries it end to end without rewriting persisted views.
- Every new local or hosted collection captures its creator's IANA timezone as
  durable authority configuration; invalid aliases and numeric offsets fail
  before collection creation.
- Local and hosted notification runtimes use the collection authority timezone
  for headless calendar evaluation.

## 0.1.0-beta.36

Beta.36 simplifies the application access decision without changing the
authorization protocol or collection semantics.

- Requests with several compatible collections now require an explicit
  collection choice before access can be reviewed.
- The default review summarizes concrete capabilities and keeps delete and
  collection-structure access visible while exact operations remain editable.
- Mandatory type and configuration setup is described as a collection change;
  expert identifiers and meaningful type-mapping choices remain available on
  demand.
- In-progress collection and permission choices survive a browser refresh for
  the lifetime of the authorization request.

## 0.1.0-beta.35

Beta.35 is a production hotfix for application approval against hosted
collections. It preserves beta.34's authority contracts and data formats.

- Hosted notification grants now carry the exact declaration identity and
  manifest digest already bound into the signed application authorization.
  This fixes approval for applications such as TaskNotes that declare hosted
  notification criteria.
- Rust and TypeScript grant summaries now require the same application identity
  fields, so an incomplete control-plane payload fails at build time.
- Safe hosted-provider validation failures retain their HTTP 422 status and
  structured problem instead of being reported as a generic storage failure.

## 0.1.0-beta.33

Beta.33 is the single successor to the undeployed beta.32 candidate. It retains
beta.32's operation transport v2, authorization binding v3, semantic capability
v1, and durable-mutation v1 contracts while deliberately breaking the
application-facing SDK surface one final time before external beta. Supported
beta.28+ data remains migration-safe; beta SDK compatibility is not preserved.

### Final SDK surface and lifecycle

- Application-facing inputs, results, and progress events consistently use
  camelCase while protocol payloads remain canonical snake_case at the
  boundary. User-owned frontmatter keys are never renamed.
- `MdbaseApplicationSession.start()` is concurrency-safe and idempotent across
  repeated starts, cancellation, failure, destruction, and framework remounts.
  Composite operations consume one monotonic request budget rather than
  restarting or dropping the caller's timeout.
- The root package now exposes a reviewed golden-path API. Protocol-author and
  cryptographic seams live on explicit subpaths, while supported outcome/fault
  builders live in `@mdbase-dev/connect-testing`. The untyped ordinary
  connection operation escape hatch and internal construction helpers are no
  longer public.
- Query/filter/order inputs are precisely typed from the canonical operation
  contract. Packed positive and negative fixtures enforce root, `/advanced`,
  `/crypto`, and testing boundaries, and every public example compiles.

### Application-declared collection setup

- Applications can declare required collection configuration, contracts, and
  type packs. Local, relay, and hosted authorities use the same canonical
  mdbase-rs assess/apply semantics, exact review digests, conflict reporting,
  idempotent receipts, and atomic setup transaction.
- Authorization binds setup to the reviewed application declaration. Generic
  collection templates remain application-neutral; existing collections adopt
  requirements without recreation or blanket template migration.

### Performance and packaging

- Hosted working sets maintain paired path/record indexes and use an explicit
  caller-owned staged-mutation boundary. Ordinary filesystem mutations retain
  mdbase-rs's collection-wide atomic shadow transaction, while hosted writes
  rely on their disposable stage plus outer PostgreSQL transaction and cache
  invalidation.
- The 10,003-record hosted gate passes with mutation p95 84.01 ms, snapshot
  1.334 s, change-page p95 27.38 ms, warm-read p95 46.72 ms, and warm-query p95
  27.5 ms. The mutation budget remains 200 ms.
- Editor, Workouts, Pickle Android, and TaskNotes must consume one immutable
  beta.33 artifact set and roll out with the matching services as one train.
  Do not activate the earlier beta.32 candidate.

## 0.1.0-beta.32

Beta.32 is a coordinated breaking release of the SDK, desktop connector,
control plane, hosted provider, MCP service, and controlled applications. It
does not preserve beta.31 SDK names, package exports, authorization binding, or
operation wire compatibility. It does preserve and migrate supported beta.28+
data, grants whose signed meaning remains exact, audit history, and completed
mutation receipts.

### Durable mutation recovery

- Every mutation uses one durable request identity and a canonical,
  cross-language request fingerprint. Identical retries return the recorded
  result, wait boundedly for a live owner, or take over an expired lease under a
  new fencing generation.
- Local SQLite and hosted PostgreSQL authorities share the same generated
  mutator catalogue and recovery-state contract. Filesystem effects record
  enough prepared/applied evidence to recover safely across Linux, macOS, and
  Windows process interruption.
- A reused request ID with different input is a permanent typed conflict. A
  stale fenced owner cannot commit evidence or a receipt.
- `operation_outcome: unknown` is reserved for the narrow case where durable
  evidence cannot distinguish whether an effect occurred. Applications retain
  the original request ID and call the pending mutation's `recover()` method;
  they must not submit the mutation again with a new ID.
- Unacknowledged completed receipts remain online for 180 days; acknowledged
  receipts become compaction-eligible after 30 days. A privacy-minimized
  request/fingerprint tombstone remains for the 365-day replay horizon after
  compaction. A retry outside the supported horizon fails explicitly rather
  than risking a duplicate effect.

This is not a claim of magical exactly-once distributed execution. It is a
testable identity, fencing, evidence, and recovery guarantee around each
logical mutation.

### SDK and compatibility

- The golden path is `MdbaseConnect -> MdbaseApplicationSession ->
  MdbaseConnection`, created with `connect.application(...)`.
  `createApplicationSession` and obsolete root transport/crypto aliases are
  removed.
- Every public asynchronous operation accepts the same final
  `ConnectRequestOptions` shape with `signal` and `timeoutMs`. Expected boundary
  failures return typed `ConnectOutcome` data; raw JSON parse, fetch, and
  database-wait errors do not cross the public boundary.
- Durable pending mutations are discoverable after restart and recover their
  stored encrypted request directly. Watch startup is bounded separately from
  the explicitly closable subscription lifetime.
- Package release, operation transport, authorization binding, semantic
  capabilities, and durable-mutation support are negotiated as independent
  contracts. Beta.32 uses operation transport v2, authorization binding v3,
  semantic capabilities v1, and durable mutation v1. An incompatible contract
  fails before the affected authority operation with a typed mismatch; a
  package-version difference alone is not an error.

### Data safety and operations

- The local registry now uses numbered, checksummed SQLite migrations, a
  durable ledger, integrity checks, and authenticated permission-restricted
  online backups. Beta.28 fixtures upgrade in place and every injected
  migration interruption resumes idempotently without touching canonical
  Markdown.
- Hosted record, resource, sync, timer, and file mutations use one
  provider-neutral PostgreSQL journal. Legacy beta receipts migrate once and
  legacy runtime paths are removed.
- Database acquisition, statements, locks, transactions, fetches, and public
  request paths have explicit bounds. Invalid responses normalize to typed
  outcomes.
- Privacy-safe release signals cover journal state/age, takeover, replay,
  request-ID conflict, unknown outcome, migration failure, database timeout
  class, invalid boundary response, and pool utilization. They contain no
  collection identifiers, paths, payloads, keys, tokens, or response bodies.

### Upgrade and recovery guidance

- Upgrade the desktop connector, hosted services, SDK applications, and managed
  consumer release train together. Beta.31 peers are valid rollback targets,
  not a reduced-semantics compatibility mode inside beta.32.
- When an application reports `upgrade_required`, update the named authority or
  application component. Authority-backed access pauses until its required
  contracts match. Canonical local Markdown, and any genuinely independent
  application replica, remain usable without making an incompatible authority
  call.
- When an outcome remains unknown, keep the draft or user intent visible,
  reconcile the collection, and recover the exact pending request. Do not use a
  generic retry that creates another mutation identity.
- Rollback restores the previous consumer artifacts and service image digests
  as one train. Restore the verified pre-migration database backup only if the
  previous binary cannot open the additive candidate schema; beta.32 does not
  retain dual legacy readers merely to support mixed-version runtime.

Unsigned macOS and Windows GitHub artifacts remain explicitly labelled preview
builds and require the platform-specific manual trust steps described in the
[release checklist](docs/releasing.md). They are not the canonical signed
installation channels.
