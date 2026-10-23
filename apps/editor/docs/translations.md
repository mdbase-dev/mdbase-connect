# Editor translations

The editor uses `@mdbase-dev/i18n` through `workspace:*`, with Lingui generated
IDs derived from English and semantic context. Source is
`src/i18n/locales/<locale>/messages.po`; JSON is generated build input.
English is statically imported and renders before any locale request. The eight
other catalogues are lazy chunks from this deployment, not a remote service.

Settings → Language offers en, fr, de, es, ja, ko, pt (Brazilian Portuguese), ru,
and zh (Simplified Chinese). A successful explicit choice is stored under
`mdbase-editor:locale`; otherwise the kit negotiates browser languages and falls
back to English. The kit updates `html.lang` and retains the working language on
load failure. Notes, paths, schema field names, installed pack content, contract
identifiers and authority diagnostics are not translated. English startup does
not imply offline collection access.

Shared controls use the workspace `@mdbase-dev/ui`, not the retired vendored UI.
Their independently compiled `uiCatalogues` and `connectUiCatalogues` exports
are passed to the kit’s `libraries` option alongside the editor catalogue. The
kit composes real message envelopes synchronously in English and atomically
switches all library and application catalogues together for target locales.
Run `pnpm build:packages` before direct editor checks to build these exports. All
core macros, shared controls and the React provider use the same Lingui singleton.
Locale changes do not remount forms or CodeMirror and do not discard drafts.
CodeMirror's standard phrases come from the kit and are compartment-reconfigured.

## Authoring

```sh
pnpm --filter mdbase-editor i18n:extract
# Edit target PO files, preserving ICU arguments, plural/select cases and rich tags.
pnpm --filter mdbase-editor i18n:check
pnpm --filter mdbase-editor build
pnpm --filter mdbase-editor build:e2e
```

Use rpnpm for finite verification/builds on this machine. Extraction and catalogue
edits stay local. The CLI is invoked by its workspace script path because pnpm 11
symlinks its executable and the initial kit CLI's entrypoint identity test otherwise
returns without running a command. Remove that workaround when the kit fixes its
symlink-aware entrypoint.

The check validates extraction sync, raw target completeness before fallback,
generated IDs, ICU/rich-text contracts, strict compilation and the full editor
source guard. It runs before both production and E2E builds and in Editor CI.
Missing translations must block these gates: never fill them with English to
make a build green. A narrowly scoped English-only compile is useful during
source authoring, but is not evidence that the release build passes.

Use whole messages and ICU plurals; do not concatenate translated words to form
sentences or compare translated labels to control behavior. Command IDs, sort
values and field kinds remain stable. Late-bound command/option getters keep
labels current without translating at module evaluation. Dates and counts use
the active display locale; Portuguese uses pt-BR and Chinese zh-CN.

The workspace UI has a different development SDK tarball from the editor’s
production-pinned SDK. Editor TypeScript paths and Vite deduplication resolve
shared UI SDK imports to the editor pin, avoiding two nominal client identities
without repinning the SDK or changing shared package configuration.

The literal `{field}` in path-template examples is syntax, not UI prose; its exact
source-guard exemption is recorded in `i18n-policy.json`.

React tests render through `src/test/locale.tsx`, exercising the real kit and
Lingui provider rather than a translator mock. Target translation acceptance also
requires browser checks of the picker, persistence, non-Latin and long-text
layouts, plus the normal repository gates. Mechanical checks do not certify
language quality.
