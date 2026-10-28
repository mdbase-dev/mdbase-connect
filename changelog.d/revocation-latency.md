## Fixed

- Bound routine policy-history verification to one acknowledged item per poll so a historical backlog no longer delays fresh revocations by a full scan. Retain full ordered recovery when policy loss is detected.
- Publish account-key strict-mode revocations through the direct post-commit policy emitter wake.
