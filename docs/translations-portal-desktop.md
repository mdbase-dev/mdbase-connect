# Portal, desktop and shared UI translations

This branch is stacked on `feat/i18n-kit`; see `packages/i18n/README.md` for
catalogue contracts and the nine supported locales. Portuguese is Brazilian
Portuguese and Chinese is Simplified Chinese.

## Ownership and commands

| Scope | PO source | Package |
| --- | --- | --- |
| Public UI | `packages/app-ui/src/locales/{locale}/messages.po` | `@mdbase-dev/ui` |
| Connect-only UI | `packages/ui/locales/{locale}/messages.po` | `@mdbase/connect-ui` |
| Portal | `apps/portal/src/locales/{locale}/messages.po` | `@mdbase/connect-portal` |
| Desktop, including native menus/dialogs | `apps/desktop/src/locales/{locale}/messages.po` | `@mdbase/connect-desktop` |

Run `pnpm --filter <package> i18n:extract` after marking English source.
Translators author only target PO catalogues. `pnpm i18n:check` validates all four
scopes before the normal root build/typecheck; it rejects missing/fuzzy entries,
English placeholders, stale extraction and incompatible ICU/rich-text contracts.
The app and private UI checks also use `check --compose` with every library's
compiled JSON, so conflicting shared IDs fail before release.
Reviewed identical examples/proper nouns need generated-ID allowlists in the
scope's `i18n-policy.json`. The reviewed lists cover placeholder-only/version
layouts, IDs and Esc, example addresses, Workouts, and genuine identical terms:
French collection/installation/application/description; German Details, Name,
Optional, Screenshot, System, Status, Online/Offline, mobile App, and `in {folder}`;
Spanish byte/bytes, Beta and Editor. These are per-locale generated IDs, not
blanket English exemptions. JSON is generated and ignored, not a second authoring
format. Ordinary package-only development builds permit Lingui's fallback while
authoring; they do **not** certify translation completeness. Release validation
must run the root strict checks first. No translation service or CI authoring.

Package commands use the kit's unconditional `mdbase-i18n` bin entry (fixed in
kit b4134d71), including real npm/workspace symlinks; no adapter is needed.

## Runtime

Each app composes its catalogue with both independent library CatalogueSources.
Identical compiled values deduplicate; conflicting app/library or library/library
translations fail closed both in strict checks and at runtime. There is no
shared-ID filtering or silent override. Shared retry actions use the library's
authored wording; semantically distinct labels (for example the current browser
session versus the current application) have their own source context.
English is imported synchronously. Literal dynamic JSON imports let the web
bundler emit per-locale local-deployment chunks. A failed chunk or conflicting
library/app message retains the active locale. Application records, identifiers,
paths, protocol diagnostics and native authority errors are not translated.

Portal stores explicit selection as `mdbase:portal:locale` in localStorage; a
language picker is available beside appearance controls, including sign-in.
Browser language negotiation is used when there is no valid explicit choice.
Desktop stores the explicit locale as UTF-8 in `<userData>/language`. Its main
process negotiates Electron's preferred OS languages; trusted IPC supplies the
same choice to the renderer and persists changes. Both processes use the same
compiled app messages, including tray menus and local dialogs. Native chunks are
bundled into the signed local app, not fetched from a service. Renderer
`html.lang` and display-only Intl formatters follow the active locale.

The public library exports `uiCatalogues` from `@mdbase-dev/ui/i18n`; the private
library exports `connectUiCatalogues` from `@mdbase/connect-ui/i18n`.
Both keep Lingui and the kit as peers and publish no uncompiled macros.
Existing pure presentation helpers use Lingui's singleton: consumers with core
macros must compose into that same instance (or deduplicate core in their
bundler), not create an unrelated isolated translator. The public `i18n` export
names the library's instance for monorepo consumers under workspace hoisting.

## Packed handoff

Build and test the library before `pnpm --filter @mdbase-dev/ui pack`. Packed
`dist/locales/{locale}/messages.json` files and the `/i18n` entry must all be
present; smoke-import the unpacked entry and invoke all eight loaders. External
products vendor the coordinated tarball and record its source SHA and SHA256.
An explicitly labelled **integration-only** tarball may contain compiler fallback
while authoring is incomplete; replace it after all strict catalogue checks pass.
It is never evidence of an authored target language or permission to release.

No package publication, deployment, release or merge to main is authorized by
this work. Browser layout acceptance must be repeated with authored German and
Japanese/Chinese app catalogues, and native OS acceptance remains separate.
