# CLI and daemon

The `mdbase` command and the desktop's bundled daemon are `mdbn-daemon`, built
from [`runtime/crates/daemon`](../runtime/crates/daemon). See
[`runtime/README.md`](../runtime/README.md) for its design. The legacy root
connector (`crates/connect-cli`, `connect-agent`) is no longer built, published
or tested; see [legacy retirement](legacy-retirement.md).

## Collection deletion

To delete a synced collection from the account:

```sh
mdbase collection delete Research --confirm 'Research'
# A full UUID also addresses a collection that is not registered on this computer:
mdbase collection delete 11111111-1111-4111-8111-111111111111 --confirm 'Research'
```

The CLI authenticates with the daemon's control key before using its signed-in
owner-device credential. This computer must first
join the collection, with any required device approval. `--confirm` is mandatory
even with `--yes` and must match the current shared catalog name, which can differ
from a registered local alias. Duplicate local names require an ID. A mismatch
refuses deletion. Deletion ends hosted access permanently but retains the local
files and registration. `mdbase collection remove Research` separately unregisters
the local folder; it does not delete hosted data or local files. See
[synced collection deletion](next-collection-names.md#delete) for retention and
uncertain-response behavior.

## Desktop boundary

Electron is responsible for windows, native folder selection, opening browser
approval pages, notifications, and presenting state. It does not own a second
mirror registry, cloud credential, retry loop, or agent child process.

At startup the desktop:

1. enters the shared boot gate and completes any persisted update recovery;
2. resolves installed-service versus isolated-profile targeting through CLI paths;
3. reconciles a stale installed runtime without controlling a different profile;
4. asks the selected daemon target to start if its endpoint is absent;
5. requires canonical readiness and the expected binary version before admitting
   daemon-backed IPC, with a bounded wait and an attention state on failure;
6. subscribes or polls for versioned status, keeping local health separate from
   account reachability and resource-specific failures.

See [exact recovery and health](exact-recovery-and-health.md) for the readiness
contract, revocation confirmation, and bounded owner-specific recovery. Critical
worker detection does not imply automatic restart or a verified service owner.

Desktop exit closes only its control connection.
