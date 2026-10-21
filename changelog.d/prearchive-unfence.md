## Fixed

- Add a migration-token route that returns a never-started account's hosted collection from a pre-archive fence to active after its archive failed before acceptance. It undoes only Connect's own latest recorded pre-archive fence run, refuses accepted archives, started or cut-over accounts, superseded or changed runs, run-owned replica revocations and inactive authority, keeps the authority epoch unchanged, serializes with the other migration steps and calls the provider once.
