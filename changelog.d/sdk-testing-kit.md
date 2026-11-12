## Added

- SDK testing kit: `MemoryReplica`'s `describe` lists the declared contracts and what each type implements, including a type file's own `implements` list, so app tests no longer stub the catalogue. `MemoryContract` takes `path` and `binding`.
- SDK testing kit: `replica.failNextRead(method)` and `replica.pauseReads(method)` fail or hold one kind of read, which drives a real change watch or record set through its states.
- SDK testing kit: `replica.client()` connects a client, `seed` and `editElsewhere` take plain frontmatter, `MemoryReplicaOptions.parse` reads documents with the app's YAML parser, and `createTestApp` and `createApplicationFixture` take the app's problem `messages`. `docs/sdk-testing.md` is the guide.
