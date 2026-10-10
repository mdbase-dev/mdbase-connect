# Isolated full TaskNotes UI/service LAB harness (test tooling only)

Unlike `../daemon-client`, this bundles the **actual complete TaskNotes source
plugin**, not just its mutation backend. Nothing activates the production port.
LAB owns registration, profile, installation, fresh preflight, launch, metadata
snapshots and exact-process-tree cleanup. Never use the user's Obsidian CLI/profile
or the shared 10k collection. No daemon reset/re-pair/rebuild is authorized.

## Build

From `packages/obsidian-runtime`, run `node e2e/tasknotes-ui/build.mjs` with:

- `LAB_TASKNOTES_SOURCE_ROOT`, `LAB_TASKNOTES_HEAD`: clean full source checkout
  and exact 40-character commit (currently `24cef502…`).
- `LAB_WRITE_CLIENT_SOURCE`, `LAB_WRITE_CLIENT_HEAD`: strict publication adapter
  snapshot and exact commit (`e28e7aba…`). Builder compares its bytes to the git blob.
- `LAB_SDK_DIST`, `LAB_SDK_HEAD`, `LAB_SDK_INVENTORY`: actual SDK JS artifacts,
  source pin and SHA inventory. Every inventoried JS file must match; do not rebuild
  from a separate worktree. Current SDK pin is `efc949ec…`.
- `LAB_FIXTURE_FILE`: LAB's registered, ready, fresh `[test]` fixture descriptor.
- `LAB_STATUS_FILE`: its fresh `entry-status.json`. An existing pending sentinel is
  acceptable **only for compilation**; it fails runtime entry. LAB must populate
  real verified LAB/native status before launch. Never substitute old preflight.
- Optional `LAB_UI_OUT`: owned artifact directory; default
  `e2e/.work/tasknotes-ui-bundle`.

Output is `main.js`, full plugin styles, manifest (ID **tasknotes**), and an artifact
inventory of source pins, SDK and harness SHA values. Keep it private. The full
plugin's existing internal `tasknotes` lookups therefore resolve normally.

## Real installation and execution path

1. Validate LAB envelope, physical fresh-root containment and exact active vault.
2. Open the real localhost SDK connection and query; no fake transport/store.
3. Install `MdbaseMutationBackend(SdkWriteClient(actual SDK))` in the **same bundled
   VaultMutationService singleton before inherited full-plugin `onload`**.
4. Enable `enableMdbaseSpec` explicitly only in this test profile. Full
   `initializeCoreServices` runs `MdbaseSpecService.initialize`. Resource bases are
   actual physical `SafeMetadata.read` snapshots, not SDK record `find` results.
   `SafeMetadata`/`MetadataTransaction` use the backend's resource mutation/CAS
   path; new resources use `mustNotExist`. SDK `submit(...wait: published)` must
   return real final publication. Rejections are not vault-fallback permission.
5. LAB installs all three dist files into its fresh `.obsidian/plugins/tasknotes`,
   starts only its private isolated Obsidian, and invokes:

   ```sh
   LAB_UI_CDP_PORT=9372 LAB_UI_INSTANCE_OWNED=yes node e2e/tasknotes-ui/run-ui.mjs
   ```

   The runner attaches/disconnects only. It does not launch/stop applications or
   the daemon. It waits for full-plugin initialization, then starts one bounded
   scenario; never automatically reruns ambiguous writes.
6. Actual `TaskCreationModal` is rendered with synthetic `[test]` data, and its DOM
   Save event runs the real TaskService and VaultMutationService path. Then the
   actual TaskService updates status, an actual edit modal renders, and SDK plus
   vault readback must agree. Observe both record and resource publication; a
   missing publication receipt cannot pass. Track attempted paths before submit.
7. LAB snapshots metadata after, retains owned notes/ambiguous writes, and verifies
   its process tree/CDP stopped. Never infer cleanup from this runner's success.

## Scope

A pass means isolated desktop full-source plugin initialization/resource writes,
modal **create Save**, full-service update, edit-modal render and readback. It does
**not** mean interactive edit-dropdown/save coverage, dirty/open-editor fencing,
quiescent plugin teardown, fresh CP/grant admission, Cloud copy/Private hosted
behavior, offline resumption, mobile, streaming attachments or release activation.
Fixture-default inclusion predicates are test-only, not production classifiers.
Errors export only bounded stage/codes, never raw SDK frames, credentials or
renderer logs. `diagnostics.mjs` captures at most eight fixed-vocabulary receipt
state/publication/status and problem code/recovery/reason projections **before**
the adapter turns a rejection into an Error, and typed submit throws before the
plugin catches them. Unknown strings are redacted; no mutation IDs, messages,
issue text/codes, details or frames escape. Generic errors do not invent a cause.
For an explicitly authorized negative initialization slot, compile with
`LAB_UI_MODE=negative_initialization`. It never runs modal or TaskService CRUD;
unexpected successful initialization reports `negative_not_reproduced`, not a
UI pass. The artifact and result pin this mode. Default `full_ui` is unchanged.
Creation uses an exact nonce-bound sanitized filename (`test tasknotes-ui-<UUID>.md`),
not a relaxed prefix check. Result booleans distinguish wrong filename, absence
of SDK create routing, and missing final record publication. Modal Save/physical
file existence never substitutes for native publication. Planned task paths are
retained before Save even when an unported product path bypasses the SDK.
`npm test` includes ten diagnostic/mode/creation tests and four entry/root guards; these are
not live qualification. Pre-existing cleanup tests remain separate.
