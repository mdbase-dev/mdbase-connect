# Linux installer patches

`electron-installer-common@0.10.4` and `electron-installer-redhat@3.4.0`
only support one executable link. The desktop's `additionalBinaries` option
adds `mdbase` without changing the `mdbase-connect` launcher or duplicating
the CLI binary. The common installer creates the extra link in the package
staging directory; the RPM patch includes it in `%files`. DEB already packages
the entire staging directory. No installation script creates unowned files.

These pinned patches serve `apps/desktop/forge.config.cjs`. Remove them when
upstream makers support additional package-owned executable links, migrating
the config and retaining the lifecycle tests. Dependency upgrades must preserve
both patches until then.

Verification:

- `node --test apps/desktop/test/linux-packaging.test.mjs`: configured links,
  missing CLI failure, and RPM manifest rendering.
- `pnpm test:system --suite linux-packages`: real Forge makers with minimal
  executable fixtures; disposable Ubuntu 24.04 and Fedora 43 containers test fresh
  installation, reinstallation, upgrade from a desktop-only package, ownership,
  non-root invocation, and removal.
- `node apps/desktop/scripts/verify-linux-packages.mjs current.deb current.rpm
  [previous.deb previous.rpm]`: the same lifecycle checks for actual release
  artifacts. The desktop release workflow runs this against both built packages.

A separate package owning `/usr/bin/mdbase` must be resolved by the package
manager: do not use force-overwrite flags or maintainer scripts to replace it.
An independently installed `/usr/local/bin/mdbase` can still shadow `/usr/bin`;
`command -v mdbase` identifies which executable the shell selects.
