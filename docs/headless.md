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

## Read and write records

The data commands work on the collection folder you are in, another folder with
`-C PATH`, or a registered collection with `-c` and its ID, ID prefix or name:

```bash
mdbase query --types task --where 'status == "open"' --order-by -due
mdbase read tasks/review.md --json
mdbase validate
mdbase types list
mdbase create --type task --fields '{"title": "Review"}' --body-file notes.txt
mdbase update tasks/review.md --fields '{"status": "done", "due": null}'
mdbase rename tasks/review.md done/review.md
mdbase delete done/review.md --if-revision <revision>
mdbase batch --request ops.json
```

When the daemon serves the folder, a command goes through it. Otherwise the CLI opens
the folder itself for the one command. It refuses a folder that another process
holds open, a folder inside a registered collection while the daemon is stopped
(exit `3`), and a folder that contains a registered collection. Registered
collections open only once the computer is signed in.

`validate` with no paths checks the whole collection within the replica's
validation budget, which a collection of more than a few hundred records
exceeds (`too_large`); name paths to check some records of a larger one.

`read --json` prints the record with its revision. Pass it back with
`--if-revision` so a write fails rather than overwrite a change made in
between. Every write takes `--dry-run`. `batch` applies all its operations or
none; `mdbase batch --help` shows the request shape. A write returns once its
file is written. If the file changed on disk or is held, the change is recorded
without writing it; the command says so, and `mdbase holds` lists held files.

With `--json`, each command prints its result, and a failure prints
`{"error": {"code", "message", "reason"}}`. Exit codes are `0` for success, `1`
for an error (including `validate` finding an error), `2` for invalid usage
and `3` when the daemon is not running.

## Hosted read canary

The canary drives the previous connector CLI's `connect login` and
`connect hosted` commands, which the mdbase daemon CLI does not have; run it with
a CLI from an earlier mdbase connect release.

`scripts/hosted-read-canary.mjs` registers the exact portable CLI manifest,
then checks one immutable Markdown marker through the native hosted CLI path.
This exercises application registration and authenticated hosted access in one
bounded probe. Enrollment is deliberately interactive and separate
from scheduled execution:

```bash
mdbase --state-dir /secure/persistent/canary-state connect login
mdbase --state-dir /secure/persistent/canary-state connect hosted authorize \
  <collection-id> --operations describe,read
```

Approve only the final `describe,read` grant. The canary rejects broader or
different grants. Keep the state directory persistent across runs and use the
platform's normal keyring or credential store; the state directory alone does
not contain the grant credentials. Do not select the insecure test secret
backend and do not pass credentials to the canary.
Run it without `MDBASE_CONNECT_SOCKET`; inherited endpoint overrides are
rejected so the selected state directory cannot probe another environment's
daemon.

Compute the expected digest from the marker's exact UTF-8 Markdown bytes, with
the `sha256:` prefix. Then schedule the probe with explicit non-secret inputs:

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
  --timeout-ms 30000
```

Every option also has an `MDBASE_HOSTED_CANARY_*` environment-variable form;
use either the argument or its environment variable, never both. A scheduler
should retain only the one-line JSON result. Exit `0` is operational, `1` is a
probe failure, and `2` is invalid or unsafe configuration. Re-enrollment is a
manual keyring-backed action, not part of the scheduled probe.

Failed CLI commands retain only a fixed allowlisted error code from the CLI's
JSON stderr (for example `daemon_unavailable`, `hosted_http_error`, or
`authorization_changed`). Process failures are classified as `timeout`,
`output_limit`, `cli_unavailable`, or `cli_signaled`; unrecognized errors remain
`cli_failed`. No message, arbitrary code, response body, credential, or path is
reflected. These codes narrow diagnosis, not root cause: `hosted_http_error`, for
example, does not identify the HTTP status. Keep both the installed CLI and the
canary script current; copying a new script does not upgrade the daemon.
