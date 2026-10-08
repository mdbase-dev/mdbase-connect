# Hosted original-genesis bootstrap record

The authenticated `GET /internal/v1/next/collections/:id/service-devices/:kind` response retains its existing seven service-device fields and adds:

```json
{"genesis":{"seq":1,"item":"<canonical base64 of the ORIGINAL complete signed CBOR item>","hash":"<lowercase 64-hex SHA256 of those exact bytes>"}}
```

The deployment token still reads only its own service kind. The collection must still be a current cloud copy: the existing collection/service-device checks and share lock cover original-genesis lookup and complete response construction. The original seq-1 policy batch must be unique, appended, nonempty, at most 64 KiB, and structurally admissible canonical bounded CBOR for that exact collection/position. Missing, nonappended, malformed, foreign, ambiguous or oversized original state returns `503 original_genesis_unavailable`; it never discovers a replacement genesis from the log. The complete serialized record is bounded to 128 KiB.

This is the original control-plane registration outcome from `next_policy_batches`, not the current log head or an unsigned SQL hash as trust authority. Structural admission uses the existing policy CBOR decoder with depth32/canonical-struct checks; it is **not** a second cryptographic verifier. Before any KMS unwrap, private key access or Worker open, the deployment must independently verify the returned exact signed bytes with its authenticated bundled PolicyPins: original collection/seq/item shape, CP certificate/root/policy-key pinning, strict signature and exact SHA256. Derive the native `expected_genesis` only from the verified bytes. Do not trust the hash, record, CP-advertised key, or a SQL/log-discovered value alone, and do not add another build-asset verifier.

The original genesis may predate a later transition into cloud-copy mode. Its original state is retained verbatim, not rewritten to describe today's mode. Neither it nor its hash grants current cloud-copy permission or proves keyed/readable/Saved state; current control-plane checks and the runtime's signed policy/read gates remain separate.

Public producer regression tests cover exact original bytes/hash/signature preservation, both deployment-kind gates, original pre-transition state, missing/nonappended/corrupt/foreign/duplicate/size refusal, aggregate response overflow and existing concurrent-leave ordering. Hosted Worker/native verifier and shared signed build-pins consumption are owned separately by the hosted workstream.
