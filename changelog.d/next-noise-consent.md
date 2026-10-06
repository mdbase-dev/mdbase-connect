## Added

- Next-backend accounts record an explicit Noise-only consent on each local
  grant: the approving owner device, its Noise key, connector and collection.
  Token issuance, the connector policy feed and relay activation serve such a
  grant only to that exact current device; missing legacy encryption is never
  treated as Noise authority, and legacy accounts are unchanged.
