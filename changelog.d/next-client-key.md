## Added

- With `MDBASE_NEXT_CONTROL_PLANE=1`, an app can register its mdbase-next Noise key
  at consent with `client_noise_key`, an attestation signed by the grant signing key
  that its authorization binding certifies. The server verifies it and refuses weak
  keys, then copies it to the grant on local approval. Daemons receive the key and
  its attestation in the grant feed. Authorization bindings stay at v5, so today's
  connectors are unaffected.
