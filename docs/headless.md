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
approval still selects the collection and permissions; first contact is then
confirmed locally, including in a fully headless session:

```bash
mdbase --json connect trust list
mdbase --json connect trust show REQUEST_ID
mdbase --json connect trust accept REQUEST_ID --code AUTHENTICATION_STRING
```

Do not expose the local control socket or named pipe over a network. Back up the
state directory and OS credential store according to the recovery guidance for
your platform.
