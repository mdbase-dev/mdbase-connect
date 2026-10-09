# Native migration cutover metadata

`GET /v1/next/collections/{id}/migration-record` is mounted when the next control
plane is enabled, independently of the operator migration token. It accepts an
ordinary connector bearer for a currently registered desktop or CLI device.
Installation, application, session and service credentials are not substitutes.

A bounded transaction locks current accounts, connector/device identity and the
collection. It rechecks the original bearer, caller backend `next`, active owner,
current cloud-copy runtime, current policy membership, exact acknowledged device
enrollment, device revocation and permanent collection-deletion denial. A current
cross-account member reads the actual owner's ledger, not its own account's.
Owner discovery alone grants nothing and is revalidated under the collection lock.

The success body is bare JSON with exactly eight fields:

- `collection_id` and `legacy_collection_id`: equal canonical preserved UUIDs;
- `ids_preserved`: `true`;
- `s_final`, `cutover_seq`, `barrier_f`: canonical unsigned decimal strings, without
  conversion through JavaScript numbers; `cutover_seq <= barrier_f`;
- `final_digest`: 64 lowercase hexadecimal characters;
- `cutover_at`: UTC ISO timestamp.

All responses use `Cache-Control: no-store`. Invalid/nonordinary credentials get
401. Unauthorized/nonexistent/noncurrent collections get indistinguishable
404 `not_found`; an authorized collection with no current cutover record gets
409 `not_cut_over`. Lock contention is retryable 503 `busy`; unexpected storage
failures fail closed, never become a successful record or an absence assertion.

The existing ledger serializer is canonical rather than duplicated. A read does
not issue a challenge, mint a credential, publish policy, mutate migration state
or contact a provider. These facts are metadata, **not** proof of installed C..F,
current native admission, policy/key possession, physical byte preservation or
permission to activate a mirror. The consuming native reader must retain its
fresh pairing/account/capture guard and independently verify installation.

Tests use isolated local PostgreSQL and synthetic acknowledged policy batches.
They qualify authorization/currentness, bigint precision, the exact wire shape
and mounting without a migration token—not deployed/native/provider operation.
