# Embedded notification contracts

These JSON Schemas are byte-for-byte copies of the event artifacts in
`mdbase.runtime.standard` 0.2.0 from `mdbase-dev/mdbase-spec` commit
`92f0032a086cc265d3415189cbf6245e369b13c4`.

They are embedded so local and hosted authorities can admit events while
offline. Run `pnpm sync:runtime-contracts` with a sibling `mdbase-spec`
checkout (or set `MDBASE_SPEC_DIR`) to refresh them. The runtime computes and
pins each contract digest from these exact bytes; this directory contains
passive schemas only and cannot register executable code.
