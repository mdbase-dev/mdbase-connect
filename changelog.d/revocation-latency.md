## Fixed

- Deliver fresh policy before routine history verification, then rotate collection probes within a 500 ms / 32-probe poll budget so loss detection keeps progressing without delaying fresh revocations by a full scan. Retain full ordered recovery when policy loss is detected.
- Publish account-key strict-mode revocations through the direct post-commit policy emitter wake.
