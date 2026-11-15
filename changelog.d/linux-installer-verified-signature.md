## Changed

- The Linux install script (`install-linux.sh`) now requires `cosign` and
  verifies the package's Sigstore signature against the release workflow before
  installing. Without `cosign` it stops and explains how to install it;
  `--allow-unverified` installs with only the checksum check and prints a
  warning. A package passed with `--deb` is reported as user-supplied and is
  not verified. Each platform's `SHA256SUMS` release file now also has a
  Sigstore bundle.
