## Fixed

- MCP gateway now signs Connect refresh token requests with the approved grant signing key for native (`mdbase-next`) collections, preventing connections from failing with `invalid_grant` after one hour, and preserves OAuth error codes/descriptions returned by Connect.
- Portal authorization return screen now cancels its automatic redirect countdown when the user clicks the return link and ignores duplicate clicks, preventing aborted/replayed single-use OAuth callback requests (`499`/`400`).
- Portal authorization consent screen no longer offers the legacy `mdbase-connect://authorize` desktop-approval continuation path for `mdbase-next` accounts, where the desktop app cannot complete pending browser authorization requests.
