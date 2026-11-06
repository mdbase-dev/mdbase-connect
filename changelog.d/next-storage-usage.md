## Added

- Show real hosted storage use for accounts on the native runtime, counted by the log service and including recent version history.
- Add a default-off scheduled sweep (`MDBASE_NEXT_OBJECT_GC=1`) that removes unreferenced objects, so deleted files stop counting towards storage use.
