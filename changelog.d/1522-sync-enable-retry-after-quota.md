## Fixed

- Turning sync on when your account is at its synced-collection limit no longer leaves the folder paused. The folder keeps working locally, and turning sync on again works once a slot is free. Before, every retry failed with `registration_mismatch` until the folder was removed and added again.
- Turning sync on again after an interrupted attempt now finishes it, instead of failing with `registration_mismatch`. This includes the automatic Private sync of a taken-over collection. A collection you paused yourself now gets a message that says to resume it first.
