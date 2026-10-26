## Fixed

- Keep editor fallback note titles, default filenames, generated type descriptions and Connect's default collection name stable across interface languages while preserving user-authored text.
- Keep the mobile editor's rename-path action independent of translated menu labels.
- Show app, collection, type, field and schema names literally in the editor, Connect and the desktop app when they contain markup-like text such as `<0/>` or `<b>`, and translate the editor's "Exit focus mode" menu label.
- Show names containing backslashes, such as `C:\x41dir`, literally in every language instead of decoding them as escape sequences; the fix is in `@mdbase-dev/i18n`'s shared runtime.
