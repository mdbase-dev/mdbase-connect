## Fixed

- The Windows Desktop build no longer fails in the MCP App view build: its catalogue compile step now starts `pnpm` through a shell on Windows, where `pnpm` is a `.cmd` shim.
