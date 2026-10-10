# Fixtures for mdbn-legacy

`connect-sql/` is vendored verbatim from `mdbase-connect@7d91bd3f`
(`crates/connect-core/src/registry/migrations/`). Tests build old connector state
directories at each schema version by executing these files, so the readers are
checked against the exact DDL old connectors created. Don't edit them; re-vendor from a
newer tag if an old format changes (it can't: these are released schemas).

No fixture here contains real user data. Engine journals and receipts are synthesised
in the tests.
