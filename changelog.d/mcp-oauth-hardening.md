## Security

- The MCP gateway limits open client registration and authorization per client address, caps authorizations in progress, and deletes expired authorizations and registrations that never obtained a token.
- The MCP gateway detects reuse of a rotated refresh token and revokes every access and refresh token issued from that authorization.
