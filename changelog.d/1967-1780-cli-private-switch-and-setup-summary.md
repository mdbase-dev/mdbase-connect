## Changed

- When switching a synced collection's storage mode isn't available yet (`mode_switch_unavailable`), `mdbase sync mode` and `mdbase sync mode-status` now explain how to create a new collection in the target mode and copy or move notes into it.
- Collection setup review (`setup.plan()` and `SetupReview`) now groups repeated identical change lines (such as multiple shared formats, note types, checks, or settings) into one clear summary bullet with a count instead of repeating the same sentence for every item.
