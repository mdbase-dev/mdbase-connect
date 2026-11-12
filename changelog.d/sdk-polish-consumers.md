## Changed

- Move the Editor, the shared app UI and the MCP service to the reworked `@mdbase-dev/sdk` API: one `createMdbase` entry, trailing read options, plain JSON values, and `connect` from `@mdbase-dev/sdk/thin-client`.
- Pin the shared app UI's development SDK and the MCP service's SDK to the published `@mdbase-dev/sdk@0.1.0-beta.188`. The MCP service was on a vendored `0.0.0` build; that tarball and an unreferenced one are removed, and the server and MCP images no longer copy `packages/app-ui/vendor`.
- `@mdbase-dev/ui` now needs `@mdbase-dev/sdk` `0.1.0-beta.188` or later when the SDK is installed: it reads the storage warning from `snapshot.sync.attention`.
