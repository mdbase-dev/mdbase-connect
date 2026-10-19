## Changed

- Attribute policy-emission failures with sanitized callback phase, nonce/RPC
  step, route name, error code and bounded owned-frame summary. Keep failures at
  error level without logging raw errors, collection identifiers, tokens or
  endpoint URLs; retry, ownership and durable acknowledgment semantics are unchanged.
