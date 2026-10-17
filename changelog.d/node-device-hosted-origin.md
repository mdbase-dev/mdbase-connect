## Fixed

- Allow Node and CLI device-flow applications to use hosted record, sync, and file operations without an `Origin` header when their approved portable capability requires a valid application-key proof. Browser origin restrictions and mirror authorization are unchanged.
- Preserve hosted provider authorization denial codes in typed SDK outcomes instead of reporting them as unknown problems.
