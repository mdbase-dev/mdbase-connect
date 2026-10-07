## Fixed

- Derive app-key fingerprints shown in consent and relay policy from the canonical policy `H(client-fp)` domain hash. Display the first 16 hex characters as `xxxx-xxxx-xxxx-xxxx`, matching native clients. These display strings are recomputed from stored public keys on each response, not persisted; no data migration is needed. Private grant approval already verifies the canonical full digest and is unchanged.
