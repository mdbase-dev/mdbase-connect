## Added

- Web applications can ask for access to a Private collection. The account owner or a member approves it in the browser, then a desktop of the account approves it on the device; until then the collection is listed as needing approval.
- Collection routes and the installation collection list report availability: available, or unavailable because the desktop is offline, needs an update, is blocked by an older connector still running, still has to approve the app, or because the collection must be set up again after moving to the new sync (`sync_required`).
- Desktops can fetch the terms of a pending Private grant (`GET /v1/next/grants/:grantId/terms`) to show before approving it.
