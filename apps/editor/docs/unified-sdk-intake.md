# Unified SDK intake — 2026-10-14

Editor and the shared collection UI consume the SAME SDK archive from
`72f8ea6caeafa4b089d3ee14c3b38ce492511a2c`, SHA256
`d58ee0fb78f2a3bfb49cc70e92bea69fe2292eb2b1cfff0cd9c222efba6d9374`.

The callback page delivers to the original SDK owner. It does not self-close or
start another owner: original Native completion and custody acknowledgement
precede the SDK's close. Application declarations and storage identities are
unchanged; no app-side protocol or SDK implementation is added.

Qualified: editor and shared UI tests, dependency builds, LAB SDK-path bundle,
whole Node `ci:local --node` gates with the architecture check rerun locally
because rpnpm intentionally excludes Git metadata. No Rust/server request path
changed. Native admission, data reads/edits/reload and production release
qualification remain separate. `build:lab` selects the SDK runtime but does not
supply a hosting-origin/deployment receipt; the normal guarded deployment must
provide the exact approved manifest origin.
