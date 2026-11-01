## Added

- A staging build of the native daemon (`--features staging`) for running the native S0 release lane against staging with the exact candidate source. It embeds the reviewed staging trust asset, signs in only to `https://connect-staging.mdbase.dev`, and cannot be combined with LAB or local-rehearsal. `runtime/scripts/native-staging-artifact.mjs` builds it reproducibly and records a receipt that binds the artifact to its source commit and to the Ops staging trust handoff (#1094).
- Every daemon build now refuses at startup to reconnect account state that another environment's build signed in from the same data directory. `mdbase status` reports the mismatch, and signing out clears it.
