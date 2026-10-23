## Fixed

- Recognize explicit-instance Lingui macros, nested ICU plural/select helpers and instance-field translations in the i18n source guard without exclusions. Check unmarked copy passed to locally rendered React state, including interpolated recovery notices.
- Check app/library translation collisions before runtime with `mdbase-i18n check --compose 'library/{locale}/messages.json'`; report conflicting IDs, locales and values using the runtime's compiled-catalogue merge rules.
