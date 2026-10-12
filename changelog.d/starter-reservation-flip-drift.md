## Changed

- The account migration start records a digest of the account's starter reservation, and the account flip refuses with `starter_reservation_changed` when the reservation changed since the start (or `starter_provisioning_in_flight` while it is being provisioned). The reservation is carried through the flip unchanged.
