# CLI and daemon

The `mdbase` command and the desktop's bundled daemon are `mdbn-daemon`, built
from [`runtime/crates/daemon`](../runtime/crates/daemon). See
[`runtime/README.md`](../runtime/README.md) for its design. The legacy root
connector (`crates/connect-cli`, `connect-agent`) is no longer built, published
or tested; see [legacy retirement](legacy-retirement.md).

## Pair a browser with a local collection

On Unix, run `mdbase pair-app [folder]` in a terminal. Choose an initialized
collection containing `mdbase.yaml`. If another app hosts it, close the
collection there first. This command serves the folder while the terminal is open.

1. Open the direct-connection edition of your chosen app using its publisher's
   instructions. From the address bar, copy the HTTPS scheme, hostname and any
   non-default port. Leave off the path, query and fragment. Choose **add**,
   paste the origin and check the exact site before confirming. A browser you
   pair there can read and write this collection.
2. Press Enter to continue with the displayed sites. Choose **This computer only**
   for a local browser. For another device, match the host's address on their
   shared Wi-Fi, Ethernet or VPN. Confirm the folder, sites and address.
3. Choose **pair** and name the browser. Open the link on the selected network.
   A private network link also has a QR code. Check the site in the browser
   before entering the separate eight-digit code. Each site has one code at a
   time, valid for three minutes and five attempts.
4. The terminal reports when the host grants access. **List** shows granted
   browsers and the latest pairing window if one remains. **Revoke** removes
   the selected browser's access, including open sessions. To reuse a granted
   label, revoke that browser first. To remove a whole site, restart setup and
   choose **remove**. Confirming removal immediately revokes every grant and
   outstanding code for that site, even if you then quit setup.

For browser requirements, certificate expiry and unattended `mdbase self-host`
commands, see [self-hosted web access](../runtime/docs/self-hosted.md).

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
