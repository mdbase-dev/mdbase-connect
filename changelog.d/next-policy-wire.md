## Added

- The server can sign mdbase-next policy items with a control-plane policy key
  certified by an offline root. It is off unless `MDBASE_NEXT_CONTROL_PLANE=1`; when
  on, startup checks the key, its certificate and its expiry. `next:cp-cert` issues
  certificates and key-revocation digests offline.
