## Changed

- Publish the source-built SDK at the Connect release version after exact tagged production verification: production-only npmjs with provenance, plus individually attested, integrity-pinned staging/LAB tarballs on never-Latest GitHub prereleases from the same build. Preserve beta.141 production trust, refresh the application WASM from the ported runtime, and keep dry runs nonpublishing. Existing app pins are unchanged and SDKs cannot use the off-CI archive publisher.
