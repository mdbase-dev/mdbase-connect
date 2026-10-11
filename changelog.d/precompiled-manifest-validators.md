## Changed

- `@mdbase-dev/connect-protocol` validates application manifests with precompiled standalone validators generated from the published schemas. Validation results, issues and strict refusal are unchanged, and the package no longer depends on Ajv at runtime, so browser bundles that import manifest validation are smaller.
