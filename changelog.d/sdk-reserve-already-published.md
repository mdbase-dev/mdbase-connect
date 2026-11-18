## Fixed

- The npm release coordinator no longer fails with `publication-reservation-unconsumed` when it plans a reserved tag that its successful publisher run already published but npm still hid; it confirms the published versions and their provenance, retrying for about three minutes, and dispatches nothing.
