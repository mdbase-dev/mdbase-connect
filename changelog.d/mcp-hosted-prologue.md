## Fixed

- MCP tool calls to a cloud-copy collection's hosted replica now send the client prologue before the Noise handshake, as the hosted replica requires; the session was previously closed before it started.
