## Security

- The MCP gateway limits open client registration and authorization per client address, caps authorizations in progress, and deletes expired authorizations and registrations that never obtained a token.
- The MCP gateway detects a rotated refresh token returning more than 30 seconds after it was replaced and revokes every access and refresh token issued from that authorization.
- The MCP gateway encrypts the PKCE verifier of its Connect authorization under its master key, like its other upstream credentials. Collection approvals started before the upgrade must be started again.
