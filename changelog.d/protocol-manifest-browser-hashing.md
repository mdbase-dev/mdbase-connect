## Fixed

- Make the canonical application manifest parser usable in browser and Worker
  bundles without Node crypto imports. Type-pack document and upgrade-baseline
  digest checks remain synchronous and preserve their existing UTF-8 hashes,
  validation issues, and versioned parser behavior.
