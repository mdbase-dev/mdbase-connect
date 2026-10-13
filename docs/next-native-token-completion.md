# Private token completion metadata

Bound next-native Private token replies include `native_completion` version 1:

- `account_id`, `authorization_request_id`, `application_id`
- `application_declaration_id`, `application_manifest_digest`
- `application_installation_id`, `application_origin`
- `collection_id`, `grant_id`
- `grant_signing_public_key`, `client_noise_public_key`

These facts come from the same approved grant, completed original authorization and retained original request/grant attestation. Missing or mismatched source refuses issuance before token inserts; the canonical caller transaction also rolls back code or refresh consumption. Hosted and local replies are unchanged.

`grant_id` names the original authorization grant, not a routing/policy-log alias and not an IK input. The account is the approving principal, which may differ from the collection owner. The installation is the original native P-256 identity, not a Worker device or hosting computer.

The SDK must compare these facts with its original protected preparation and independently verified Worker account before storing credentials or publishing the choice. Unbound legacy records cannot be relabelled to the current account; they require explicit recovery/reapproval.

Completed request/proof expiry does not expire a separately active grant. An offline computer does not prevent token completion. This metadata does not prove credential persistence, Worker custody/Noise ACK, effective native policy, a live lease or admitted READ.

This slice adds no reconciliation endpoint, DDL or new authority lock order. Lost-reply/store-failure credential reconciliation and stronger concurrent-authority guarantees remain separate contracts.
