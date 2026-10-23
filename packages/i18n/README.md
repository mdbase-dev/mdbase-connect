# @mdbase-dev/i18n

Shared, locally authored Lingui 6.9 tooling and React runtime. No remote service,
AI provider, translation network endpoint or application data model.
English starts synchronously; an app's own bundler serves lazy non-English JSON.
Supported locales: `en fr de es ja ko pt ru zh`. `pt` is Brazilian Portuguese
(the TaskNotes plugin explicitly labels it Português (Brasil)); `zh` is Simplified Chinese.
Mechanical checks do not certify linguistic quality or native-device acceptance.

## Adopt

Install this package, `@lingui/core@6.9.0`, `@lingui/react@6.9.0` and React 19.
For Vite, also install `@lingui/vite-plugin@6.9.0` and configure the Lingui plugin
as in the Lingui Vite documentation: macros must be transformed, not shipped as calls.
A React Babel pipeline can instead use `@lingui/babel-plugin-lingui-macro@6.9.0`.
This kit does not replace the application's build configuration.

`lingui.config.mjs` (or `.ts`):

```js
import { i18nConfig } from "@mdbase-dev/i18n/config";
export default i18nConfig({
  include: ["<rootDir>/src"],
  exclude: ["**/*.test.*", "**/*.spec.*"],
  path: "<rootDir>/src/i18n/locales/{locale}/messages",
});
```

`package.json` scripts:

```json
{
  "i18n:extract": "mdbase-i18n extract",
  "i18n:compile": "mdbase-i18n compile",
  "i18n:check": "mdbase-i18n check"
}
```

Mark visible copy with Lingui macros. Let IDs be generated from English + semantic
context; never invent explicit IDs. Add context for ambiguous short action/state
labels. Don't translate user data, paths, product names or protocol identifiers.
Don't translate eagerly at module scope, nest `t` inside another `t` interpolation,
or use translations in comparisons, lookups or CSS identifiers.

Run extract, author all eight target PO files, then check. PO is the authoring source.
The check runs extraction sync, raw-PO completeness **before fallback**, generated IDs,
ICU argument/type, select/exact numeric cases, offset, pound and numeric React-tag
contracts, strict JSON compilation and the structural source guard. Plural categories
follow the target locale's grammar (Japanese/Chinese need not have English `one`;
Russian needs its own categories). Missing, fuzzy and English-placeholder translations
fail. Nothing in CI authors translations.

Reviewed identical terms/proper nouns require explicit per-locale generated-ID
allowlisting. Optional `i18n-policy.json`:

```json
{
  "allowIdentical": { "fr": ["generated-id-for-a-reviewed-proper-noun"] },
  "source": {
    "include": ["src/components", "src/screens"],
    "exclude": ["**/generated/**"],
    "brands": ["YourProduct"]
  }
}
```

Includes are directories, relative to the config root (not glob expressions).
Excludes are glob patterns. The guard defaults to catalogue includes/excludes and
skips tests, locale data and node_modules. It catches visible JSX/attribute strings
and unsafe translation placement, not arbitrary UI copy in every non-React dependency;
source review remains necessary. Keep exclusions narrow and justified.
`mdbase-i18n source` runs only the guard; `--config path` selects a Lingui config.

## Runtime and picker

Create one runtime **outside React rendering**. Apps already using core `t` macros
should pass `i18n` from `@lingui/core` as the optional `i18n` property. The provider
and non-React helpers then share that singleton. Omit it for an isolated instance.
Only one runtime may own a supplied instance. English is a static import;
enumerate imports so Vite/other bundlers can make local-deployment chunks:

```tsx
import english from "./i18n/locales/en/messages.json";
import { createI18nRuntime } from "@mdbase-dev/i18n";
import { LocaleProvider, LanguagePicker } from "@mdbase-dev/i18n/react";

const loaders = {
  fr: () => import("./i18n/locales/fr/messages.json"),
  de: () => import("./i18n/locales/de/messages.json"),
  es: () => import("./i18n/locales/es/messages.json"),
  ja: () => import("./i18n/locales/ja/messages.json"),
  ko: () => import("./i18n/locales/ko/messages.json"),
  pt: () => import("./i18n/locales/pt/messages.json"),
  ru: () => import("./i18n/locales/ru/messages.json"),
  zh: () => import("./i18n/locales/zh/messages.json"),
};
export const runtime = createI18nRuntime({
  english,
  loadLocale: async (locale) => (await loaders[locale]()).default,
  // Adapter is app-owned. Catch unavailable browser storage here if best-effort.
  storage: {
    getLocale: () => localStorage.getItem("my-app:locale"),
    setLocale: (locale) => localStorage.setItem("my-app:locale", locale),
  },
  // Optional native OS locale list; defaults to navigator.languages.
  // preferences: ["fr-CA"],
});
// Wrap the root once; portals retain real Lingui context.
<LocaleProvider runtime={runtime} onError={showLanguageLoadError}>
  <App />
</LocaleProvider>;
// Inside a translated component:
<LanguagePicker label={t`Language`} onError={showLanguageLoadError} />;
```

The native, unstyled select has an accessible name, endonym options and a loading/
disabled state. Apply your existing select class. Apps own translated error notices.
`initialize()` is idempotent and provider-triggered after the immediate English render.
Explicit saved choice wins; otherwise the first supported browser/OS base language
wins, then English. An explicit user selection persists after successful activation.
Unsupported persisted choices are ignored. Failure retains the working catalogue
and previous choice; late loads can't replace newer selections. Storage adapter
errors are reported rather than silently swallowed. `html.lang` and `dir=ltr` track
activation. English startup does not mean collection access works offline.

Use `useLingui()` in components and `runtime.i18n` outside React. If you inject
Lingui's global singleton, existing core macros work unchanged. With an isolated
runtime instead, use
`const { t } = useLingui()` from `@lingui/react/macro`, or core macros with the
runtime explicitly supplied, `t(runtime.i18n)` / `runtime.i18n._(msg`...`)`.
Do not mix separate translator instances.

`formatters(runtime.i18n.locale)` provides Intl-backed `date`, `number` and
`relativeTime` functions. Call during rendering so a language change updates display.
These are display-only; never use them for persisted timestamps or enum values.
Portuguese Intl formatting uses `pt-BR`, Chinese `zh-CN`.

## Library catalogues (shared UI packages)

A library owns its source scope and nine PO catalogues; **do not extract its source
again into every app catalogue**. It does not create an i18n instance or provider.
React library components use `useLingui`/`Trans` from the parent app context.
Source macro calls must be transformed by the library build before publication:
plain `tsc` does not compile Lingui macros. Ship compiled JS and ICU JSON, never
untransformed macros requiring the consumer to process node_modules.

Export a `CatalogueSource` from a small `/i18n` entry point. For example
`packages/app-ui/src/i18n.ts`:

```ts
import type { CatalogueSource } from "@mdbase-dev/i18n";
import english from "./locales/en/messages.json" with { type: "json" };
const loaders = {
  fr: () => import("./locales/fr/messages.json", { with: { type: "json" } }),
  de: () => import("./locales/de/messages.json", { with: { type: "json" } }),
  es: () => import("./locales/es/messages.json", { with: { type: "json" } }),
  ja: () => import("./locales/ja/messages.json", { with: { type: "json" } }),
  ko: () => import("./locales/ko/messages.json", { with: { type: "json" } }),
  pt: () => import("./locales/pt/messages.json", { with: { type: "json" } }),
  ru: () => import("./locales/ru/messages.json", { with: { type: "json" } }),
  zh: () => import("./locales/zh/messages.json", { with: { type: "json" } }),
};
export const uiCatalogues: CatalogueSource = {
  english,
  loadLocale: async (locale) => (await loaders[locale]()).default,
};
```

The library's config includes only its own `src` and uses
`path: "<rootDir>/src/locales/{locale}/messages"`. Run its own `mdbase-i18n check`
for all nine locales. Copy **all nine JSON files** into `dist/locales/{locale}`
and preserve the literal imports above during the library build, so the application
bundler can split its own deployment's target-language chunks. Include these files
in the packed tarball and smoke-test the packed `/i18n` entry. Add a package export:

```json
{
  "exports": {
    "./i18n": { "types": "./dist/i18n.d.ts", "import": "./dist/i18n.js" }
  }
}
```

Keep React, `@lingui/core@6.9.0`, `@lingui/react@6.9.0` and this kit as
peer dependencies (workspace development dependencies in Connect) rather than
bundling nested translator copies. The library's runtime imports are erased for
the kit type above, but the public declaration references its type.

At the application root:

```ts
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
const runtime = createI18nRuntime({
  english: appEnglish,
  loadLocale: loadAppLocale,
  libraries: [uiCatalogues],
  // i18n: globalI18n, storage: appStorage,
});
```

English is merged synchronously. On a switch, the runtime loads the app and every
library catalogue concurrently, validates/merges them, then performs **one**
activation. A failed chunk or conflicting translation retains the current language
and stored choice; no mixed-language intermediate state is activated. Previously
activated locales are reused. `mergeCatalogues([...])` is also exported for
standalone deterministic composition: output keys and nested object keys are sorted,
identical generated-ID values become one entry, and different values for the same
ID throw instead of silently overriding one another. If two concepts really need
different wording, give them different semantic source contexts; otherwise align
their translations. No library prefixes, app-side ID rewriting or duplicate messages.

For this monorepo: public `packages/app-ui` (`@mdbase-dev/ui`) ships its own
catalogues and `/i18n` export for Writer, Reader and TaskNotes. Private
`packages/ui` (`@mdbase/connect-ui`) ships a separate `/i18n` export for
Connect applications, which pass **both** sources when they use both packages.
Do not make the private package public or fold either library's UI into Portal's
application PO scope. A shared library's incomplete locale blocks that consuming
app's release; English fallback must not hide missing authored library messages.

## CodeMirror

`@mdbase-dev/i18n/codemirror` shares the fixed lookup keys from CodeMirror 6's
view, search, autocomplete, language, commands and lint packages. Keep the literal
`$` tokens: CodeMirror substitutes line/count values after lookup.
Start with synchronous `englishCodeMirrorPhrases`. On activation, await
`loadCodeMirrorPhrases(locale)` and reconfigure `EditorState.phrases` through a
compartment. Each non-English phrase dictionary is its own lazy local-deployment
chunk. Do not translate the document or serialized editor state.

## CI, packing and vendoring

Run `pnpm i18n:check` in CI before build/tests. If compiled JSON is committed,
also `git diff --exit-code -- path/to/locales` after the check. Check doesn't need
network or an AI key; only dependency installation does. There is no delivery
manifest or pack-fetch protocol in this package.

Kit verification: `pnpm --filter @mdbase-dev/i18n verify`.
`pnpm --filter @mdbase-dev/i18n test:packed` repeats the packed-consumer check:
real extraction, all nine authored catalogues, strict compile and source checks
through an npm-style `node_modules/.bin` symlink, including rejection of a broken
catalogue. The public bin always invokes the CLI; consumers should use the bare
`mdbase-i18n` commands above and remove temporary exported-main adapter launchers.
Build before `pnpm --filter @mdbase-dev/i18n pack --pack-destination <directory>`.
The tarball includes built ESM/types plus its self-contained CLI/scripts; no workspace
dependency or source checkout is required. React and Lingui core/react are peers.

Before npm publication, external products must copy the coordinated tarball into
`vendor/mdbase-dev-i18n-<version>-<shortsha>.tgz` and use a relative `file:` dependency,
then commit their lockfile. Record the exact kit SHA in the PR. **Swap the vendored
dependency for the published npm version at merge time**, once that Connect release
is available. Never depend on another worktree's node_modules or absolute paths.
This branch prepares release-cohort inclusion; it does not publish or deploy.
