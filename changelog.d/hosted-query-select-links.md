## Fixed

- Queries with `select`, projections or the CEL link helpers (`file.hasLink(link(...))`, `.asFile()`) now answer on default-hosted cloud-copy collections. The hosted replica's store did not pass these queries' bounded record reads through, so they failed as `unavailable` and MCP reported "Can't connect right now".
