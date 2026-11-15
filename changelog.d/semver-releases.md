## Changed

- Connect releases leave `0.1.0-beta.N` for plain semver. The next release of the server, Desktop, the workspace npm packages and `@mdbase-dev/sdk` is `0.1.0`; continuous release then bumps the minor version when a `## Breaking` fragment was added since the previous release and the patch otherwise. Every release publishes to npm `latest`, and the SDK's `sdk-v<version>` GitHub release is no longer a prerelease. `pnpm version:set` is removed; `pnpm version:check` only keeps the workspace cohort consistent.
