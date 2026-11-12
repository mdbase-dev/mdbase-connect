## Fixed

- MCP gateway: approving a collection in one MCP host (for example ChatGPT and a second ChatGPT workspace, Claude or the OpenAI plugin scanner) no longer revokes another host's access to the same collection for the same mdbase account. Each MCP sign-in is now its own application installation in mdbase connect, so each one keeps its own grant; existing connections keep working without approving again.
