# SDK: which entry to import

`@mdbase-dev/sdk` has two entries for talking to a collection. They share the
collection API and differ in how the collection is reached.

| Entry | For | Way in |
|---|---|---|
| `@mdbase-dev/sdk` | An app. The SDK signs in, opens the collection and keeps it open. | `createMdbase` |
| `@mdbase-dev/sdk/thin-client` | Code that makes its own connection: a server, a CLI, a plugin that talks to the desktop daemon. | `connect` |

```ts
// an app
import { createMdbase, type MdbaseClient, type RecordView } from "@mdbase-dev/sdk";

// a server holding a grant and a key
import { connect, relayConnector, keyPairFromSecret, type MdbaseClient } from "@mdbase-dev/sdk/thin-client";
```

## The collection API

Both entries export everything an app does with an open collection:

- `MdbaseClient`, `Write`, `LiveQuery`, `RecordSet` and their option types
- records, files, presence, contracts, type packs, saved views
- values: the plain types, `toValue`, `toPlain`, `Float64`, the `wire` codecs
- errors, status (`MdbaseSync`, `summarizeSync`), holds, the write ledger

The root adds what belongs to an app: `createMdbase` and its snapshot, people,
timers, notifications, hold and error copy.

## Only in `./thin-client`

The root used to export all of these. No app that calls `createMdbase` used
them.

| Area | Names |
|---|---|
| Connecting | `connect`, `ClientOptions`, `Session`, `API_VERSIONS` |
| Transports | `relayConnector`, `nextRelayConnector`, `noiseConnector`, `localLinkConnector`, `inProcessConnector`, `controlRouteResolver`, `routeFromControl`, the carriers (`webSocketCarrier`, `streamCarrier`, `duplexCarrier`, `relayPipeCarrier`), `noiseChannel`, `orderTargets`, `localLinkFirstPayload`, `pipeCloseError`, `SESSION_LIFETIME_MS` and the option and result types of all of these |
| Ports | `Connector`, `FramePort`, `OpenedPort`, `ByteChannel`, `framedPort`, `portPair`, `RecordReader` |
| Noise and keys | `keyPairFromSecret`, `generateKeyPair`, `KeyPair`, `StaticKey`, `IkInitiator`, `IkResponder`, `NoiseError`, `clientPrologue`, `staticKeyOf`, `loadOrCreateClientKey`, `indexedDbKeyStorage`, `memoryKeyStorage` and their types |
| Wire encoding | `encode`, `decode`, `encodeSecret`, `isValid`, `structMap`, `toHex`, `fromHex`, `bytesEqual`, `CborError`, `MAX_DEPTH`, `Codec`, `SchemaError`, `SubmitParams`, `AppliedPrefixParams`, `AttachmentContentV1`, `AttachmentRefV1` |
| Runtime | `WasmRuntime`, `OpenConfig`, `RuntimeInfo`, `QueryExecutionProfile` |
| Availability | `parseCollectionAvailability`, `collectionUnavailableError`, `isCollectionUnavailableReason`, `COLLECTION_UNAVAILABLE_REASONS`, `CollectionAvailability`, `CollectionUnavailableReason` |

A test that needs a client on a `MemoryReplica` calls `replica.client()`
(`docs/sdk-testing.md`).

`@mdbase-dev/sdk/browser`, the classic-script bundle, exports both entries and
is unchanged.
