## Fixed

- Sign native (`mdbase-next`) Connect refresh-token requests in the MCP gateway with the approved grant signing key and preserve OAuth error codes/descriptions from token responses.
- Prevent the Portal approval outcome screen from firing its automatic redirect after the user manually clicks the return link, avoiding duplicate OAuth callback failures.
- Hide the legacy local-folder desktop continuation on the Portal consent screen for `next` accounts, and guide zero-collection `next` users to create a collection or sync an existing folder/Obsidian vault in mdbase Desktop.
- Render HTML error pages with retry guidance on browser-facing MCP OAuth callback and connection-ticket errors, and log privacy-safe metadata when the MCP HTTP transport rejects a request with 4xx.
- Pin `services/mcp` to the verified vendored production `@mdbase-dev/sdk` archive (`0.1.40`) alongside the Editor.
