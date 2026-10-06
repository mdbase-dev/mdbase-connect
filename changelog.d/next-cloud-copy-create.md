## Added

- Create cloud-copy collections on the next control plane, behind
  `MDBASE_NEXT_CLOUD_COPY_BOOTSTRAP=1`:
  - for a signed-in account with no device
    (`POST /v1/next/collections/cloud-copy/service`), where the hosted replica is the
    first member;
  - or from an owner's registered device (`POST /v1/next/collections/cloud-copy`).
  In both cases the hosted and escrow deployments generate their own service
  devices, and the genesis enrols them.
- Enrol an owner's registered device into a cloud copy
  (`POST /v1/next/collections/:id/devices`, signed with a fresh device challenge).
  Private collections refuse this.
