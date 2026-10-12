## Fixed

- Preserve original timer generations, states and timestamps during migration; reject incomplete or conflicting records instead of resetting or skipping them.
- Require complete original account-migration readback before imported timer mutations, firing, receipts or cleanup. Bound stored provenance and prevent an old import from restoring erased timer data.
- `next-timers copy-hosted <collection>` imports every original timer of a fenced, drained hosted collection in bounded pages, verifies the imported set equals the source under one unchanged provider watermark, and records a content-free manifest. The lossy internal timer import route is removed.
- The account flip now requires the next timer service, each legacy source `migrated`, and each hosted collection's timer import to still match the provider watermark, the same legacy run and the target timer rows.
