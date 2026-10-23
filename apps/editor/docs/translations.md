# Editor interface translations

This integration is in progress. The first catalogue covers core Settings preferences,
collection facts and connection controls, plus the language picker. The person setup
panel, shared UI (including theme options), editing workspace, type editor and recovery
flows are not yet migrated. A Settings-only catalogue is not app-wide completion.

## Runtime

The editor uses `@mdbase-dev/i18n` from the Connect workspace and Lingui 6.9 macros.
English is imported synchronously. The eight other catalogues are enumerated dynamic
JSON imports, served as chunks by the editor's own deployment, not a remote language
service. Supported languages are `en fr de es ja ko pt ru zh`; `pt` means Brazilian
Portuguese and `zh` means Simplified Chinese, matching the TaskNotes plugin.

The kit negotiates browser languages when no explicit choice exists. A successful
choice is saved under `mdbase-editor:locale`; activation updates `html.lang` without
remounting the workspace or translating notes, paths or identifiers. Failed loads
retain the working language. The picker displays a retryable error; automatic startup
load errors are logged and leave English usable. Denied browser storage does not
prevent negotiation; failure to persist an explicit choice is reported by the picker.

Use `const { t } = useLingui()` from `@lingui/react/macro` in a translated component.
The kit owns an isolated Lingui instance, so importing the global core `t` singleton
would translate against the wrong catalogue. Add semantic context to ambiguous words.
Do not assemble translated singular/plural fragments or compare translated labels.
Display-only numbers and dates use the active locale; persisted values remain unchanged.

## Local authoring

PO files in `src/i18n/locales/<locale>/messages.po` are the translation sources.
English plus semantic context generates IDs. Target PO entries must be authored and
reviewed locally; empty entries must never be filled with English just to pass checks.
ICU parameters and numeric rich-text tags are contracts. Generated JSON is compiler-owned.

The kit commands are `mdbase-i18n extract`, `mdbase-i18n compile`, and
`mdbase-i18n check`. The check verifies extraction sync, raw translation completeness,
ICU/rich-text contracts, strict compilation and structural source marking. CI never
translates. The source guard deliberately names only the migrated directories until
the remaining editor screens are moved into the catalogue.

The initial PO scaffolds are intentionally untranslated. A non-strict development
compile is not translation acceptance. Strict compilation and complete catalogues are
required before this draft can be considered merge-ready.

## Validation still required

Run the full repository check suite remotely, both editor builds, bundle/CSP checks,
and local browser acceptance on an assigned port. Browser acceptance must cover the
picker, persistence, a long-text locale (German), a non-Latin locale (Japanese/Chinese),
and preservation of an unsaved note when changing language. English startup without
translation downloads is not a claim that collection access works offline.
