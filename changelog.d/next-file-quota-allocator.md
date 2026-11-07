## Added

- Add a default-off file quota allocator (`MDBASE_NEXT_FILE_QUOTA=report|enforce`) that shares each account's plan storage across its native collections. Every hour, and as soon as a collection is created, each collection gets its current file bytes plus an equal share of what the plan has left. `report` only logs accounts with no storage left; `enforce` sets the quotas, which blocks new uploads at the plan limit and keeps existing files.
