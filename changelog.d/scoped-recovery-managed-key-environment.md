## Fixed

- The native scoped recovered-byte proof now admits staging and production data with the provider's default legacy-only `local` key custody, alongside same-environment keys. `local` custody with any KMS reply and cross-environment keys still refuse, and LAB is unchanged.
- Native recovered-byte refusals keep the single fixed stderr line but exit with a stage code: 2 header and environment, 3 key preflight, 4 object proof, 1 invocation or framing.
