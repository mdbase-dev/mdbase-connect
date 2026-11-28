## Fixed

- Make MCP sign-in callbacks single-use even when approval and denial arrive together, and serialize token rotation and replay handling per sign-in.
- Reduce database work for MCP tool calls and connection listing. Keep upstream credential renewal independent of tool cancellation and offer a new approval link when collection access expires.
- Avoid a duplicate Connect route lookup when opening native MCP sessions and reduce query response size with compact JSON text.
