# Known permanent deletion facts at token refresh

The existing role-0 collection log-token route reuses `requireCollectionNotDeleted` immediately before synchronous token mint inside its existing transaction. Any permanent CP intent or observed native-registry fact denies with `409 collection_deleted` and no token/expiry. Conflicting, older or higher facts also deny; restored eligible collection metadata cannot remove this separate no-FK ledger. Unexpected database failures propagate without minting or becoming absence.

Connector/device proof, exact current keys/enrollment, collection runtime/sync state, membership, revocation and installation scope checks remain unchanged. Private and cloud-copy collections, owners and real cross-account members share this denial. An unrelated collection's fact does not deny the requested collection.

This is a known-local-fact check only. No new migration, schema, signer, configuration, native RPC or startup hook is introduced. Absence of local facts is **not** a current nil-registry/Gone observation, effect-time lease, lifecycle authority or serving permit. It does not close all key/grant/import/publication paths or replace native serialized floor/Gone/import/aux/final-publication fences. Complete startup reconciliation, typed Deleted acknowledgment, retirement/purge and activation remain separately qualified work.

Dedicated local PostgreSQL/Fastify tests check CP/native/conflicting facts, full-u64 floors, private/cloud-copy owner/member refusals, unchanged facts despite restored eligible rows, unrelated collection allowance and unexpected lookup failure without invoking the signer. Existing positive/proof/enrollment/revocation tests remain. These are not live LAB/native effect-time evidence.
