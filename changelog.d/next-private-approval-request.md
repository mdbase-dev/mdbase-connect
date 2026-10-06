## Added

- An enrolled device of a private collection can ask for a fresh SAS commitment
  (`POST /v1/next/collections/:id/private/devices/approval-request`, signed with a
  fresh device challenge). The control plane appends the signed `approval-request`
  policy op; an existing keyed device then approves the device again.
