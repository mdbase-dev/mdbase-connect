# Italian

Branch `feat/i18n-italian` is stacked on `feat/i18n-editor` at `08fda20e`.
The kit supports ten locales; Italian uses `it` and the endonym **Italiano**.

## Complete authored scope

- Portal: 825 messages; desktop: 443; editor: 1407.
- Shared app-ui: 197; Connect ui: 59; CodeMirror: 29 phrases.
- Editor translations imported from `e2ee000c`; portal/desktop from `49fd095d`.
- The editor's shared “Optional” ID uses “Facoltativo”, matching app-ui.

Picker endonyms are fixed runtime data, not catalogue messages. The picker label
itself belongs to each app's catalogue. Italian browser/OS variants such as
`it-IT` and `it_CH` negotiate through the kit's existing base-locale matching.
Electron uses `app.getPreferredSystemLanguages()` with the same negotiation and
the existing persisted `language` preference; no separate OS mapping is needed.
Intl supplies Italian CLDR rules; no hand-maintained plural table is introduced.
Required plural categories cover integer counts 0..999. Million-only cardinal
`many` is optional; ordinal `many`/`other` are covered by kit tests.

## Reviewed identical strings

The Italian policy entries preserve technical tokens, not untranslated prose:

- Editor: Markdown suffix/templates/globs, `type:`, keyboard tokens, Phosphor
  Regular, YAML; Italian UI terms Design, Offline, Runtime, Tag and File;
  interpolation-only count labels. Italian `file` is invariable; the file-type
  label is reordered as `{title}, file {0}`, not allowlisted.
- Portal: ID/version/interpolation-only labels, example email address, and
  established Italian terms Account, Beta, Editor, Email, Password and Privacy.
- Desktop: Account only. The sentence fragment ` in {folder}` is translated as
  ` nella cartella {folder}`, not allowlisted.

Identical ICU branches containing `# file`, `# byte` or `# record` are valid
Italian technical nouns, not English fallback. No completeness, contract,
source, composition or plural gate is weakened. All ten locales remain enabled.

The kit and shared UI sources are unchanged since `49bea0aa`; their Italian
adoption tarballs remain pinned to that revision. External consumers must replace
vendored `file:` dependencies with published versions at merge/release time.
