## Added

- SDK: `client.recordSet({ types?, include? })` is every record of the chosen types, read completely once and then kept current from the change feed. It reads in pages, so it holds a collection of any size, rereads only the records that changed, resumes the feed after a dropped connection, retries passing failures by itself, and tells listeners exactly which records were put or removed. `getSnapshot()` and `subscribe()` fit `useSyncExternalStore`.
