# Headless mdbase installation

The standalone `mdbase` archive contains the same native CLI and local
authorization daemon that ships inside the matching mdbase connect desktop
release. It does not contain Electron and does not introduce a second trust or
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
mdbase connect daemon install
mdbase connect daemon status
```

On Windows, extract `mdbase.exe` to a stable per-user directory, add that
directory to `PATH`, then run the same `mdbase connect daemon install` and
`status` commands from PowerShell.

`daemon install` copies the exact invoking executable into mdbase's private
runtime directory and registers the per-user service. Run it again after
installing an upgrade. For containers, SSH sessions, or supervisors that should
own the process lifecycle, use the canonical foreground entry point instead:

```bash
mdbase --state-dir /secure/persistent/state connect daemon run
```

The daemon is the final authorization boundary for local collections. Portal
approval selects the collection and permissions; the daemon then verifies the
application installation signature and persists the exact signed grant without
an additional local ceremony. Reauthorizing the same installation updates its
grant keys, while a different installation key produces a different identity.
This behavior is identical in desktop and fully headless sessions.

Do not expose the local control socket or named pipe over a network. Back up the
state directory and OS credential store according to the recovery guidance for
your platform.

## Hosted read canary

`scripts/hosted-read-canary.mjs` checks one immutable Markdown marker through
the native hosted CLI path. Enrollment is deliberately interactive and separate
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
