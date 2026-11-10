## Changed

- npm packages and the source-built SDK now publish from a reserved `v0.1.0-beta.N` tag at the production commit, so a change publishes after the next promotion even while main keeps moving. Every package in a publication shares the tag's version, and npm provenance names that tag and commit.
