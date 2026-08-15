# Disposable physical schema manifest

Each SQL file is loaded into a fresh disposable database. The GIN files include
their corresponding no-GIN definition and rename its schema, so no two variant
files are loaded into the same database.

| Variant | Exact record | Projection | Additional semantic index |
| --- | --- | --- | --- |
| A | AES-GCM ciphertext + HMAC path token | none | none |
| B-no-GIN | AES-GCM ciphertext + HMAC path token | readable envelope + semantic JSONB | none |
| B-GIN | AES-GCM ciphertext + HMAC path token | readable envelope + semantic JSONB | one `jsonb_path_ops` GIN on semantic JSON only |
| C-no-GIN | readable Markdown + readable path | readable envelope + semantic JSONB | none |
| C-GIN | readable Markdown + readable path | readable envelope + semantic JSONB | one `jsonb_path_ops` GIN on semantic JSON only |

Identity indexes are limited to declared primary keys and unique stable-ID/path
constraints. Mutable revision, sequence, timestamp, projection-version, and lease
columns receive no speculative index. There are no per-field, full-text, range,
order-revealing, blind, or automatic schema-property indexes.

All five files were syntax-validated with `psql -v ON_ERROR_STOP=1` against
`postgres:18` on 2026-08-16. This was DDL validation in disposable databases, not a
migration or deployment.
