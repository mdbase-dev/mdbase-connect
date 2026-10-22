## Fixed

- A migrated account's new collections are created on the control plane's own hosted and escrow deployments. Only legacy hosted collections of a routed owner are served by the hosted migration Worker, so creating a collection after migration no longer fails with 503.
