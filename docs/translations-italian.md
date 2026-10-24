# Italian scaffold

Branch `feat/i18n-italian` is stacked on `feat/i18n-editor` at `08fda20e`.
The kit supports ten locales; Italian uses `it` and the endonym **Italiano**.

## Completed shared scope

- `packages/ui/locales/it/messages.po`: 59 translations.
- `packages/app-ui/src/locales/it/messages.po`: 197 translations.
- `packages/i18n/src/codemirror/it.ts`: 29 phrases, preserving lookup keys and `$`.

Picker endonyms are fixed runtime data, not catalogue messages. The picker label
itself belongs to each app's catalogue. Italian browser/OS variants such as
`it-IT` and `it_CH` negotiate through the kit's existing base-locale matching.
Electron uses `app.getPreferredSystemLanguages()` with the same negotiation and
the existing persisted `language` preference; no separate OS mapping is needed.
Intl supplies Italian CLDR rules; no hand-maintained plural table is introduced.
The kit tests cover optional million-only cardinal `many` and required ordinal
`many`/`other`.

## Pending translator scopes — not acceptance-ready

All active translations are deliberately empty in:

- Portal: 825 / 825.
- Desktop: 443 / 443.
- Editor: 1407 / 1407.

Do not fill these with English, disable Italian, skip Italian in tests, or relax
`mdbase-i18n check`. That gate validates authored PO completeness before fallback
and remains the acceptance requirement. A compile can resolve missing entries
through the existing English fallback; it does **not** certify completeness.
Runtime composition tests involving Italian app/shared IDs also await translations,
since English fallback can conflict with translated library messages. Translators
must align shared IDs with the library translations or give genuinely different
app messages their own context.

No non-strict development override is needed for the kit/shared gates. All normal
strict checks and build scripts remain unchanged.
