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
both patches until then. The RPM patch also sets `%global _build_id_links none`
to prevent bundled Electron binaries from owning global `/usr/lib/.build-id`
links that conflict with other Electron applications (issue #1034). Retain that
policy until the upstream installer suppresses these links for bundled apps;
embedded ELF build IDs are unchanged.

Verification:

- `node --test apps/desktop/test/linux-packaging.test.mjs`: configured links,
  missing CLI failure, RPM manifest rendering, and the build-ID link policy.
- `pnpm test:system --suite linux-packages`: real Forge makers with minimal
  executable fixtures (including a real ELF with a build ID); disposable Ubuntu
  24.04 and Fedora 44 containers test fresh
  installation, reinstallation, upgrade from a desktop-only package, ownership,
  non-root invocation, and removal.
- `node apps/desktop/test/linux-packages/verify.mjs current.deb current.rpm
  [previous.deb previous.rpm]`: the same lifecycle checks for actual release
  artifacts, rejecting RPMs containing global build-ID links before installation.
  The desktop release workflow runs this against both built packages.

A separate package owning `/usr/bin/mdbase` must be resolved by the package
manager: do not use force-overwrite flags or maintainer scripts to replace it.
An independently installed `/usr/local/bin/mdbase` can still shadow `/usr/bin`;
`command -v mdbase` identifies which executable the shell selects.
