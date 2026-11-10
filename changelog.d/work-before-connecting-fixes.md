## Fixed

- The unsynced collection no longer stops at "Set up this collection" after it sets itself up. Readiness checks the collection again in the same refresh once automatic setup has made it ready, and a local-only status update (which reads the same before and after a commit) now counts as a possible change, so a definitions-only commit is noticed.
- Bases views work in the unsynced collection: `.base` views are discovered, their source is read and they execute, instead of being refused with `view_requires_keyed_device`. Synced and hosted replicas still require a current keyed device.
