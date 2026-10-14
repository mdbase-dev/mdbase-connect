# One collection chooser, separate authorities

The normal app Sign in/Add chooser lists eligible Private and cloud-copy collections using the same collection IDs and names. Private account consent does not require computer-side confirmation. Listing or linking a collection is not consent, custody, Native completion, or READY.

## Original-attempt composition

After original device attestation and account confirmation, the SDK prepares the existing signed Native authorization without navigating or closing the popup. Its signed authorization nonce is the base64url encoding of the original 32-byte installation challenge. The callback listener precedes attachment.

`POST /v1/pairing-requests/:id/native-authorization`, authenticated by the original pairing bearer, accepts `{authorization_request_id}`. It binds the same original account, app UUID/current manifest, declared origin, challenge and unexpired signed Native request with its original client key. Changing or reusing the association refuses; it never regenerates keys or authorization requests.

Inspect adds `kind: "private"` to eligible choices and `native_authorization_id` when prepared. The ordinary chooser sends Private consent as:

```json
{"fingerprint":"original fingerprint","collection_ids":[],"create_collections":false,"selected_collection_id":"original Private CID","selected_collection_kind":"private"}
```

The canonical Native approval helper rechecks actual Private access, current requirements and signed requested file actions. Its grant/policy publication and original account-only installation approval commit in one database transaction. Linked Native requests cannot bypass the original chooser through ordinary Native approval. Account/session expiry, cancellation and original preparation fences remain mandatory.

After commit, the same popup follows the validated same-origin `/oauth/authorize?request_id=...` URI. The original OAuth callback, state, PKCE, signing/Noise completion and protected registration/custody ACK remain unchanged. No browser receives collection keys.

## Separate receipts

A fresh Private exchange has `collection_ids: []`, `create_collections: false` and `native_selection: {authorization_request_id, collection_id}`. It omits Hosted `selected_collection_id` and `created_collection_ids`. Native selection metadata alone cannot publish or open the collection. The SDK must verify original Native completion, account, preparation and original zero-scope registration ACK first.

Additive Private approval preserves held Hosted actors and scopes; it adds no Hosted IDs. Private recovery requires exactly the original recovery CID and its committed Native selection with zero Hosted content scopes. SQL0080 adds that narrow final-transaction-state exception without editing applied0077 or relaxing its Hosted singleton case.

## Failure and qualification

Unknown approval/code/write effects are not replayed or reconstructed. Lost preparation or original custody fails closed. Native requirement guards are not upgraded from unsigned catalog metadata or legacy declarations.

Apps must ship the new SDK before migration. An old loaded Hosted-only SDK cannot acquire this protocol from a control-plane deploy. Record that old context as blocked; load the new app before a separately recorded proof, retaining the same profile/account/Native/bytes. Thereafter prove Sign in, Private selection and approval, FIRSTREADY without reload, reads, confirmed/published edit and one reload.

PostgreSQL tests qualify atomic grant/registration, rollback, immutable binding, swaps, original epoch, recovery and additive preservation. Portal tests qualify the shared chooser and absence of Hosted widening. These are not live Native readiness or app read/write/reload acceptance.
