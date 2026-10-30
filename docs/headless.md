# Headless mdbase installation

The standalone `mdbase` archive contains the same native CLI and daemon that
ships inside the matching mdbase connect desktop release. It does not contain Electron and does not introduce a second trust or
collection implementation.

## Verify before installing

Download the archive, its entry in the platform `SHA256SUMS` file, and the
adjacent `.sigstore.json` bundle from the same GitHub release. Verify the
checksum and Sigstore identity before extracting it. The expected certificate
identity is the tag-bound workflow:

```text
https://github.com/mdbase-dev/mdbase-connect/.github/workflows/desktop-release.yml@refs/tags/VERSION
```

Sigstore proves which repository workflow produced the bytes. It does not
replace Apple notarization or Windows Authenticode. An artifact whose filename
contains `UNSIGNED` is a preview and may trigger an operating-system warning.

## Install and run

On Linux or macOS, extract the archive and install the executable at a stable
path on `PATH`, for example:

```bash
install -m 0755 mdbase ~/.local/bin/mdbase
mdbase service install
mdbase service status
```

On Windows, extract `mdbase.exe` to a stable per-user directory, add that
directory to `PATH`, then run the same `mdbase service install` and `status`
commands from PowerShell.

`service install` copies the exact invoking executable into mdbase's private
runtime directory (keeping the copy it replaces as `mdbase.previous`), registers
the per-user service and waits until it is ready. Run it again after installing
an upgrade. For containers, SSH sessions, or supervisors that should own the
process lifecycle, use the foreground entry point with an isolated profile
instead:

```bash
mdbase --state-dir /secure/persistent/state daemon run
```

Sign the computer in with `mdbase account sign-in`. The daemon is the final
authorization boundary for local collections: apps reach a collection only
after you approve them (`mdbase access`), the same in desktop and fully headless
sessions.

Do not expose the local control socket or named pipe over a network. Back up the
state directory and OS credential store according to the recovery guidance for
your platform.

## Hosted read canary

`scripts/hosted-read-canary.mjs` proves, once per run, that a signed-in
computer reaches its account and reads one immutable Markdown marker from a
synced (cloud-copy) collection through the hosted log. It drives the shipped
`mdbase` CLI and daemon against an isolated profile and has no credentials or
network client of its own.

Each run starts that profile's daemon, so nothing it observes predates the
run: the account relay reports `online` only after a device-bound session with
the control plane, and the joined collection's hosted log reports `online` only
after an authenticated reply from the log service. The canary then requires the
collection to be caught up to the head the log reported (no pending changes,
holds or conflicts), reads the marker from the joined folder, compares the
SHA-256 of its exact bytes, and stops the daemon. It refuses to use a daemon it
did not start.

Enrollment is a separate, manual step. Use a dedicated canary account that is a
member of the marker collection, ideally with the viewer role, and the mdbase
binary of the environment being probed (production builds sign in only to
`https://connect.mdbase.dev`):

```bash
mdbase --state-dir /secure/persistent/canary-state daemon start
mdbase --state-dir /secure/persistent/canary-state account sign-in
mkdir -m 0700 /secure/persistent/canary-collection
mdbase --state-dir /secure/persistent/canary-state collection join \
  <collection-id> /secure/persistent/canary-collection
mdbase --state-dir /secure/persistent/canary-state status
sha256sum /secure/persistent/canary-collection/status/canary.md
mdbase --state-dir /secure/persistent/canary-state daemon stop
```

Wait until `status` shows the collection ready and synced before computing the
digest, and compare it with the marker you published: the expected digest is
`sha256:` followed by the 64 lowercase hex digits of the marker's exact UTF-8
Markdown bytes. The device identity lives in the platform keyring or credential
store, not in the state directory; keep both persistent, leave the joined folder
unmodified, and do not set `MDBASE_SECRET_BACKEND`. The folder path stays on
this computer; only the collection ID goes to the control plane.

Schedule the probe with explicit non-secret inputs:

```bash
node scripts/hosted-read-canary.mjs \
  --environment production \
  --cli /opt/mdbase/bin/mdbase \
  --state-dir /secure/persistent/canary-state \
  --expected-origin https://connect.mdbase.dev \
  --collection <collection-id> \
  --expected-collection-name "Status marker" \
  --marker-path status/canary.md \
  --expected-marker-sha256 sha256:<64-lowercase-hex-digits> \
  --timeout-ms 60000
```

Every option also has an `MDBASE_HOSTED_CANARY_*` environment-variable form;
use either the argument or its environment variable, never both. Run it without
`MDBASE_HOME`, `MDBASE_ENV` or `MDBASE_SECRET_BACKEND`; inherited overrides are
rejected so a run cannot select another profile, environment or secret store.
The timeout bounds the probe; stopping the daemon afterwards has its own
30-second bound. Do not run another daemon on the canary profile.

The probe prints one JSON line: `schema_version` 1, `environment`, component
`hosted_canary`, `status`, `checked_at`, `duration_ms`, the stages `config`,
`registration` (fresh daemon; keyring-backed account at the expected origin;
relay online), `connections` (the collection is registered once, synced, with
the expected name), `describe` (hosted log online and caught up), `read`,
`digest` and `shutdown`, and on failure an `error` with its stage and a fixed
code. Exit `0` is operational, `1` is a probe failure, and `2` is invalid or
unsafe configuration. A scheduler should retain only that line.

Failed CLI commands contribute only the daemon's stable error code or a fixed
start/stop reason (for example `start_failed`, `daemon_unreachable` or
`unauthenticated`). A wait that outlasts the timeout reports the last reason it
waited on, such as `account_offline`, `log_offline`, `not_caught_up` or
`collection_opening`. Process failures are classified as `timeout`,
`output_limit`, `cli_unavailable`, or `cli_signaled`; anything else is
`cli_failed`. No message, arbitrary code, account error text, identifier,
response body, credential, path or record content is reflected. Keep the
installed CLI and the canary script current together.
