## Removed

- The control-plane routes for legacy mirror pairing (`/v1/mirror-pairing-requests`, including the desktop approval route) and for moving a hosted collection's main copy to a computer (`/v1/authority-transfers`). Obsidian plugin releases 0.4.2 and earlier and the deprecated `mdbase-mirror` CLI now get 404 when they try to pair a folder or move the main copy. Existing hosted collections and their synced folders are still shown and can still be disconnected, and moves already in progress still expire as before.
- The portal's "Sync a folder" and "Sync folder" actions, which opened an `mdbase-connect://mirror` link that the desktop app no longer acted on, and the desktop's handling of that link.
- The `connect` and `promote` commands of the deprecated `mdbase-mirror` CLI, its access-token renewal, and the `@mdbase-dev/connect-sync/enrollment` and `/promotion` entry points. `init`, `sync`, `watch`, `status` and `resolve` remain.
