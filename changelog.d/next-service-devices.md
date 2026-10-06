## Added

- Store service-device records (public keys and KMS-wrapped private keys) for
  hosted-replica and escrow members of cloud-copy collections, and let each
  deployment fetch its own kind's record and refresh a role-0 log token scoped to
  one collection. Inactive unless the next control plane and the matching internal
  service token are configured.
