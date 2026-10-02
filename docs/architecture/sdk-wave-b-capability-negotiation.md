# Wave B B1: Authority feature negotiation

Status: proposed; documentation only. Evidence baseline: Connect `dfc28fd9`, shared
mdbase-rs `f60adfe` (`sdk-upgrade/authority`, read only). Consumer evidence is
`~/projects/sdk-review/reports/{sdk-bench,survey-apps,survey-platform}.md`; those
reports describe older working trees, not necessarily this baseline.

## Current behaviour and ownership

- `packages/protocol/src/compatibility.ts` and
  `crates/connect-protocol/src/compatibility.rs` negotiate transport 3/2,
  authorization binding 5/4, semantic capability contracts 2/1 and durable mutation
  1. These concern transport/approval, not whether query rows carry revisions.
- `packages/protocol/src/index.ts` (`RelayHello`, `RelayWelcome`, capability
  constants), `crates/connect-agent/src/relay.rs` and hosted
  `src/http/diagnostics.rs` already use capability string lists. A relay welcome
  or control-plane health response is not proof of a selected authority's query
  implementation. Local status intentionally lacks capabilities
  (`crates/connect-agent/src/server/tests.rs`, status regression).
- Local `crates/connect-core/src/registry/operations.rs` and hosted
  `src/provider/operation_reads.rs::describe_operation` produce collection
  descriptions. `packages/client/src/connection-types.ts::MdbaseConnectionInfo`
  reports granted operations/files but no runtime feature support.
- mdbase-rs owns semantic implementation and provider-profile support; Connect
  owns authenticated discovery, authorization and feature exposure. No mdbase
  semantic change is needed merely to advertise a working implementation.

## Proposal: reuse string capabilities, add authority-local discovery

Add optional `authority_capabilities: string[]` to `CollectionDescription` in
Rust and TypeScript, and to `ListFilesPage` for file-only clients authorized to
list but not describe. A legacy session without either discovery permission keeps
its existing behaviour; the SDK never requests unauthorized discovery merely to
unlock an optimization. SDK exposes immutable `authorityCapabilities` from the
normalized response and one connection-owned `supportsAuthorityFeature(id)`
helper. Absence means unsupported, not unknown-but-try. Unknown strings are ignored.

Example additions to existing responses:

```json
{"authority_capabilities":["query-record-revisions-v1","query-metadata-v1","read-many-documents-v1","contract-query-v1","link-resolution-options-v1"]}
```

A files page advertises only `files-stat-v1` when implemented. These are immutable
implementation identifiers, **not** application capability groups or entitlement
claims. Add them per running implementation/profile, not unconditionally to shared
relay constants. Advertise `query-metadata-v1` only with B3's revisions. A later
incompatible meaning gets a new suffix; optional response members and opt-in inputs
fit the existing operation/file transport versions. Keep transport and signed
contract requirements unchanged; validate Rust/TS schemas and N-1 readers together.

Discovery uses the current authenticated authority route's existing `describe`,
or an existing `list_files` request (`limit:1`, within approved scope) for file-only
use. No new discovery operation, global registry or error probe. Successful empty
lists still advertise support. A discovery failure remains a failure, never cached
as evidence of old authority. Share in-flight discovery and cache only for the
current authority/connection lifetime; clear on reconnect, authority replacement,
reauthorization and direct/relay route change. Both local routes must advertise the
same feature set. No persistent feature cache. An absent baseline advertisement is
sufficient to choose the legacy path without issuing an extended request.

## Approval, fallback and consumers

Features do not expand exact operation ceilings (ADR 0013). B3 extends existing
`read`/`query`; B4 requires existing file `list`; B5/B6 require `query`/`read` as
applicable. `supportsAuthorityFeature` never means permission. Dispatch always
rechecks locally cached exact grants, origin, current epoch/lease and file scope.
Never infer support from `operation_invalid`, empty results or arbitrary errors.

Writer, Reader, TaskNotes and editor use the connection helper and retain each
item's explicit legacy path. MCP is a protocol consumer: discover through its
existing authenticated gateway and cache per tenant+connection lifetime; never
borrow another connection's evidence. Obsidian sync is unchanged. For all five,
remove feature fallbacks only after the coordinator declares a minimum supported
local authority/provider implementing that feature, all consumer pins adopt it,
and N-1/rollback and connection-cache windows close. Until then new SDKs must work
with late-updated desktop connectors. B5 legacy scoped grants are not a fallback.

## Tests and size

S–M, roughly 3–5 engineer-days including client and both authority adapters.
Matrix: new/old SDK × new/old local and hosted authority; missing/unknown flags;
profile-specific flags; direct/relay switch; reconnect to predecessor; file-only
list; discovery failure/cancellation; permission denied despite feature support.
Assert unsupported flags cause **zero** extended requests, and response parse
failure is visible. Protocol fixtures prove additive N-1 response compatibility;
no registration, approved operation expansion or persistent migration occurs.
See [the implementation split](sdk-wave-b-plan.md).
