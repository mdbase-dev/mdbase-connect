## Security

- Sign application authorization requests from the bundled application declaration. The client now refuses an application registration whose declaration digest or family identity does not match the declaration it sent, with `invalid_operation_response`.
- Open authorization and device verification pages only on the configured Connect server's origin, at `/oauth/authorize` and `/device`. Other URLs fail the authorization with `invalid_device_authorization_response` before the client navigates, opens a window or reports a device code.
- Keep a grant's collection transport (encrypted relay, remote authority or neither) across token renewal. A renewal that changes it fails with `connector_identity_changed` and asks the user to reauthorize.
- Validate remote authority endpoints in the MCP gateway with the same rules as the client: operation, sync and file URLs on one HTTPS (or loopback HTTP) origin, at the collection's exact authority paths.
- Record in the security audit package that the runtime application SDK takes the serving device's relay key from control-plane routing.
