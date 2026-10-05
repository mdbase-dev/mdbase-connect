## Added

- Let an owner's registered device create a cloud-copy collection on the next
  control plane (`POST /v1/next/collections/cloud-copy`, signed with a fresh
  device challenge). The hosted and escrow deployments generate their own
  service devices, and the collection's genesis enrols the owner's device and
  both service devices; the owner's desktop then performs the initial rekey.
  Off unless `MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1`.
