# Actual LAB daemon client in isolated Obsidian

Test-only bundle: real SDK localhost Noise transport, real `SdkWriteClient`, real
TaskNotes `MdbaseMutationBackend`. It queries then attempts published create/update,
waits for Obsidian's index and compares SDK + vault readback. Missing publication
receipt or unsupported published wait is **blocked**, never confirmation fallback.
No full TaskNotes UI, embedded WASM store or handoff is enabled.

Build with explicit inputs (no tokens in arguments/files):

```sh
LAB_SDK_DIST=<fresh-sdk-dist> \
LAB_WRITE_CLIENT_SOURCE=<actual-source-from-166> \
LAB_TASKNOTES_BACKEND_SOURCE=<tasknotes-v5>/src/core/mdbase/MdbaseMutationBackend.ts \
LAB_FIXTURE_FILE=<coord>/lab/integration-fixture-link-context.json \
LAB_STATUS_FILE=<private-verified-lab-status-json> \
node e2e/daemon-client/build.mjs
```

Status must assert `environment: lab`, `identity: verified`,
`connect_origin: https://connect-lab.mdbase.dev`, `daemon.running: true`.
Fixture root must be `[test]` below the context file's `integration-fixtures`, and
must exactly match the opened Obsidian vault. SDK reads owner-checked daemon state
files directly; the bundle never duplicates or logs their token.

Install `.work/daemon-client-bundle/{main.js,manifest.json}` only into that disposable
vault's `.obsidian/plugins/mdbase-lab-daemon-client`. Launch an extracted Obsidian
with isolated HOME/XDG, private `--user-data-dir`/runtime dir, xvfb, CDP127.0.0.1:9372.
Never use the user's Obsidian launcher or profile. Only one isolated instance.

Enable `mdbase-lab-daemon-client` through `e2e/cdp.mjs` `waitPlugin`; read only
`app.plugins.plugins["mdbase-lab-daemon-client"].result` for bounded evidence.
On unload/scenario completion the SDK connection closes. Keep attempted `[test]`
notes as identified safe fixtures; do not mutate the LAB owner's baseline notes.
