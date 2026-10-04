## Added

- The server can sign mdbase-next policy items with a control-plane policy key
  certified by an offline root. It is off unless `MDBASE_NEXT_CONTROL_PLANE=1`; when
  on, startup checks the key, its certificate and its expiry, and every item is
  refused outside the certificate window. `next:cp-cert` issues certificates and
  key revocations offline, always from structured input that it prints before
  signing.
