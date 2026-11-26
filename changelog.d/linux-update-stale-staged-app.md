## Fixed

- On Linux, an update staged but never installed (for example because the app was still running) no longer blocks every later update. The updater could not remove the app's `resources/app.asar` from inside Electron, so each later check failed with "directory not empty". Apps already stuck this way need one manual step: quit mdbase connect, delete `~/.local/opt/mdbase-connect.next` and `~/.local/opt/mdbase-connect.previous`, then run `mdbase-connect --mdbase-update`.
- `mdbase doctor` now reports a failed update check with its error. Before, it said only when the app last checked successfully, and pointed at a background service that had nothing to show.
