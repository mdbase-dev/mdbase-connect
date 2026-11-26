## Added

- SDK record updates and editing leases accept `requireLive: true` to keep a deleted record deleted, even when an offline edit replays. The rejected receipt reports `not_found` with reason `deleted`; ordinary updates still restore the record.
