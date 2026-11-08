## Fixed

- Revoke published application grants before removing a deleted account from
  shared native collections, so replicas apply the policy item and revoke the
  member's devices. Previously voided policy history is not repaired.
