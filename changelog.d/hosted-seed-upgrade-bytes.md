## Fixed

- Hosted collections served by the legacy provider no longer re-serialise an
  edited seed type when upgrading it: the provider image now pins the
  filesystem engine revision that keeps the app's published text for upgraded
  settings.
