## Breaking

- SDK: the root entry no longer exports connection plumbing. `connect`, the transports and connectors, Noise and client keys, `Session`, the CBOR encoding, `WasmRuntime`, `inProcessConnector` and collection availability are now only in `@mdbase-dev/sdk/thin-client`, which still exports everything the root's collection API does. Apps that call `createMdbase` are unaffected; code that calls `connect` imports it from `@mdbase-dev/sdk/thin-client`. `docs/sdk-entries.md` lists what moved.
