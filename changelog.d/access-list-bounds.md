## Fixed

- A daemon reply too large for one control message is answered with a `too_large` / `response_too_large` error. The CLI no longer reports it as `daemon_unreachable`, including when an older daemon sends the oversized reply.
- The device's app access list (`access.json`) no longer stores the full setup declaration of each app on local collections, or of declined and revoked apps. Some apps' declarations are hundreds of kB each, and the list was rewritten whenever the account's grants were refreshed. Existing lists shrink on the next refresh; no app has to be approved again.
- `mdbase access ack --collection <collection>` marks every "can now use this collection" notice of a collection as seen at once. Apps waiting for approval are left alone.
