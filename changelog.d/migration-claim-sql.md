## Changed

- Reduce authenticated hosted-migration claim SQL round trips while preserving
  fresh source/target checks, key locks, one-use nonce expiry and acknowledged
  transaction commits. No protocol, schema, timeout or readiness changes.
