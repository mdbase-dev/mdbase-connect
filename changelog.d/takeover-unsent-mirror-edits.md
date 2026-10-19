## Fixed

- Preserve unsent edits from old hosted mirrors during takeover, rejoin their collections automatically, and show waiting imports, recoveries and conflicts without modifying the old folders.
- Vendor the canonical daemon importer from NEXT #931 (`18f32bd5a`), retaining recovery bytes in its existing owned capture and using fresh rollout permission for explicit retries as well as startup.
