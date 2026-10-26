# Portal, desktop and shared UI translations

Shared UI messages belong to two separate package catalogues:

- Public `@mdbase-dev/ui`: `packages/app-ui/src/locales/<locale>/messages.po`.
- Private Connect UI: `packages/ui/locales/<locale>/messages.po`.

The source language is English. Target locales are fr, de, es, ja, ko, pt (Brazil),
ru and zh (Simplified). The scaffold intentionally contains empty target entries,
not English placeholders. It is not a completeness claim or release candidate.

Use each package's `i18n:extract`, `i18n:compile` and `i18n:check` commands. The kit
validates source/context IDs, authored completeness before fallback, ICU contracts,
strict JSON compilation and unmarked JSX copy. Builds transform core Lingui macros;
never publish untransformed macro calls. Catalogue JSON is compiler-owned data.

Core presentation helpers and shared controls use Lingui's singleton. Consumers
must supply `i18n` from `@lingui/core` to `createI18nRuntime`, so their provider and
library copy use one translator. Shared controls subscribe without remounting forms.
Existing English-only consumers can still render without a React translation
provider, using source messages synchronously. Collection-copy getters preserve
its existing `{app}`/`{collection}` fill API and never translate user-owned values.

Each package will export a self-contained CatalogueSource from `/i18n` for the
kit's library composition contract: synchronous English and lazy per-locale JSON.
Library translations must not be copied into consuming application catalogues.

Translation scaffold checkpoint: package extraction succeeds; full multilingual
checks will necessarily fail until local authors complete all eight catalogues.
Native packaging and browser-language acceptance remain separate gates.
