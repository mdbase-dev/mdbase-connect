## Added

- Create private (end-to-end) collections on the next control plane from an owner's
  registered device (`POST /v1/next/collections/private`), behind
  `MDBASE_NEXT_PRIVATE_BOOTSTRAP=1`. The genesis enrols only that device, and no
  hosted or escrow device is ever enrolled.
- Enrol a registered device of a current member into a private collection with its
  SAS commitment (`POST /v1/next/collections/:id/private/devices`). The device holds
  no key until an existing keyed device approves it and grants the key.
