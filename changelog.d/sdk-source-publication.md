## Changed

- Prepare source-built, environment-pinned SDK publication: production-only npmjs with provenance, plus individually attested staging/LAB tarballs on immutable, never-Latest GitHub prereleases from the same build. Dry runs and the separate runtime-port gate remain fail-closed; existing app pins are unchanged and SDKs cannot use the off-CI archive publisher.
