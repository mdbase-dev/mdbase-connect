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
edits stay local. The workspace kit includes 8785bd19's source guard and catalogue
composition checks (and the repaired normal executable symlink). No CLI adapter
or direct-script launcher is needed.

The check validates extraction sync, raw target completeness before fallback,
generated IDs, ICU/rich-text contracts, strict compilation and the full editor
source guard. `i18n:check` also composes each compiled editor catalogue with both
`node_modules/@mdbase-dev/ui/dist/locales/{locale}/messages.json` and
`node_modules/@mdbase/connect-ui/dist/locales/{locale}/messages.json`, using the
same collision semantics as the runtime. Build both libraries first. Conflicting
IDs must be aligned or given semantic source context, never silently overridden.
The check runs before both production and E2E builds and in Editor CI.
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

Reviewed identical translations are allowlisted by generated ID, not replaced with
artificially different wording. The de/es/fr/ja/ko/pt/ru lists cover file extensions, ICU-only
layout, shortcut notation, YAML, font/product names and literal path/search patterns.
Spanish also legitimately retains “Compatible”. French retains cognates (Actions,
Collection, Compact, Compatible, Date, Description, Documentation, Incompatible,
Maximum, Minimum, Notes, Notifications, Pack, Projections, Type(s), Validation,
Version), pixels and extension/note plurals. These are deliberate translations,
not English fallback. German also retains cognates such as Details, Definition,
Format, Link(s), Name, Optional and Text; Japanese retains technical Null and Ctrl;
Portuguese retains links, pixels, Offline, status and Via mdbase. Literal diagnostic
brand envelopes and schema/path tokens stay unchanged. Shared German Details uses
the portal's explicit `URmyfc` allowlist, without padding. Russian generic Details
and Remove align with the public library's Подробности and Удалить to avoid an
ID collision; contextual settings Details remains separate. `progress.py` flags
some legitimate identical translations heuristically.

The merged de/es/fr/ja/ko/pt/ru POs are not evidence of nine-locale release
readiness: zh is still pending. Unmerged locales must block `i18n:check` and both
builds; a scoped authored audit or authoring compile never replaces those gates.

The approved mechanical-only plural delta replaces positional aliases for the
required-field warning, installed-pack notice and folder accessible name with
consistent named arguments in every branch. Translations retain their prose;
ja/ko use only `other`, and ru retains `one`/`few`/`many`/`other`. Another 50
identical Japanese `one` arms were mechanically dropped: Japanese never selects
that category, and their `other` prose is byte-identical. The coordinator's
`burst/inventory/editor-id-moves.json` records old IDs `bntbp-`, `tB4Bkm`, `OCHeER`
and their replacements `G_yv_v`, `F2TEex`, `xNjFKW`, including the placeholder map
for porting the pending zh translation.

React tests render through `src/test/locale.tsx`, exercising the real kit and
Lingui provider rather than a translator mock. Target translation acceptance also
requires browser checks of the picker, persistence, non-Latin and long-text
layouts, plus the normal repository gates. Mechanical checks do not certify
language quality.
