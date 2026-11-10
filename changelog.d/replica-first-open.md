## Changed

- A signed-in app reopens a cloud copy from the replica on its device instead of waiting for Connect. A collection that has synced on this device before is handed to the app after a local read; the log token is requested in the background and the first sync turn follows. The app shows the collection as of its last sync and updates when that turn lands. The start no longer waits for the collection list, for the log token (two requests whenever the 16-minute token has expired) or for the first sync turn. Private collections and a collection's first open on a device are unchanged.
- Opening no longer needs the network when the log token has expired. An app that is offline at start opens what it holds and connects when the network returns; before, it reported that the collection could not be opened.
- A signed-in start shows the collection list kept from the last listing at once and reads Connect's list afterwards. File actions are absent until that read, and a collection missing from the kept list is not treated as removed.

## Fixed

- Saved views can be read while a reopened app replica re-derives its keys from the log. They were refused with `view_read_not_ready` until the first sync turn, so an app that was offline at start listed records but showed no view.
