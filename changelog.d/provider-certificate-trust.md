## Security

- The hosted provider no longer trusts the eMudhra intermediate certificates
  whose keys were compromised in October 2026. Its release lock moves to
  rustls-webpki 0.103.17 and webpki-roots 1.0.12, and the development lock to
  the same versions. The server and MCP images already run a patched Node 24.
