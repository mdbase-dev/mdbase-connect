# @mdbase-dev/obsidian-runtime

The mdbase-next runtime host inside Obsidian (desktop and mobile). Plugins
(TaskNotes, mdbase-obsidian) embed it and share one instance per app process.

The host implements the vault, journal, index and editor-fence interfaces.

## What it provides

| Module | What | Status |
|---|---|---|
| `src/embed/` | Embedded-WASM loading: table-driven base64 decoder + gzip | done |
| `src/shared/` | The shared runtime: `globalThis.__mdbase_runtime__` keyed by ABI major, one instance per runtime version, the version-skew rule, handoff (`replica-client-api.md` §13) | done |
| `src/journal/` | The dual `Journal`: IndexedDB `strict` + CRC-framed append-only vault file, union recovery, A/B compaction | done |
| `src/vault/` | The vault `FilePlatform` (`GuardedInPlace`) over Obsidian's vault/adapter API: guarded replace/create/trash, events, move pairing, Android case-only renames, sync-tool detection | done |
| `src/index/` | `IndexStorage` on sqlite-wasm `opfs-sahpool` in the runtime's Worker | done |
| `src/fence/` | The editor fence: `fence_report` / `fence_apply` through CodeMirror (replica client API §14) | done |

The Rust side of each interface is in `crates/store-file`: `platform.rs`,
`index.rs`, `journal.rs` and the host queue in `host.rs`.

| `src/keys/` | Private sync: device key storage, commit-then-reveal approval, recovery key, status UI | done |
| `e2e/` | Isolated desktop Obsidian (`desktop.sh`, `run-desktop.mjs`) and Android emulator (`android.sh`, `run-android.mjs`) suites | done |

## Platform invariants and qualification limits

- **Editor fence:** publish to an open note through its buffer, not behind the
  editor's back. A blind save can overwrite even an atomic outside rename.
  `vault.process` serializes only vault writers; it is not CAS against outside processes.
- **Dual journal:** recover the union of the IndexedDB and vault-file copies.
  IndexedDB `strict` requests durability; successful requests and process-restart
  tests do not establish physical power-loss durability. The vault adapter offers no fsync.
- **sahpool index:** the index is disposable: rebuild when absent or corrupt,
  integrity-check after an unclean open. A second opener is refused as `Busy`;
  a clean restart reports `Existing`.
- **Vault platform:** preserve the BOM, refuse occupied rename destinations,
  use a temporary name for case-only renames, and pair external moves as
  `RenamedFrom`/`RenamedTo`. These checks do not make outside writers atomic.
- **Keys:** use SecretStorage through the host's platform implementation;
  credential custody and restart behavior require platform-specific qualification.

Desktop and isolated Android-emulator suites live under `e2e/`. Their results do
not qualify real-phone OEM background killing or physical storage durability.
**iOS remains unverified:** `adapter.append` to a dot-folder
(`.mdbase/devices/…`) and its durability require device testing. Check `journal-a.log`
after the `journal` suite, together with the `kills` suite, before claiming support.

## Sharing rules

- Every plugin embeds a byte-identical runtime build and calls
  `sharedRuntime(ABI_MAJOR).register(pluginId, info, create)`. The first plugin
  with a version instantiates it; others reuse it.
- `attach(plugin, version, collectionId, ctx)` decides host / client / handoff /
  daemon / `upgrade_required`. Attachments re-home after a handoff
  (`onRehome`).
- The registry object on the global is created by whichever plugin loads first,
  so its method set is part of the ABI: change it only with an ABI major bump.

## Checks

```sh
npm ci && npm run typecheck && npm test && npm run build   # or: cargo xtask obsidian
```
