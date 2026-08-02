# Security audit preparation package

Status: internal preparation; no independent security review has occurred

This document is the human entry point for reviewing mdbase Connect's security
boundaries. The complete, test-validated source map is
[`config/security-audit-package.json`](../config/security-audit-package.json).
It deliberately distinguishes implemented controls, live operational evidence,
and remaining limitations. It is not an audit report, certification, or claim
that an independent assessor has approved the design.

## Review scope

The package covers application authorization, first-contact trust, encrypted
relay traffic, local connector enforcement, hosted-provider enforcement and
encryption, managed data-key wrapping, and release artifact integrity. Collection
semantics remain implemented by `mdbase-rs`; this repository is responsible for
checking authority before invoking them. Cloud resources and runbooks live in
the private `mdbase-cloud-ops` repository and should be reviewed alongside the
public implementation during an authorized operational assessment.

The central authority rule is intentionally redundant:

- the application signs a ceiling on what it requested;
- the portal lets the user choose a collection and narrow that request;
- the local connector is the final boundary for a computer-owned collection;
- the hosted provider is the final boundary for a hosted collection; and
- no control-plane status or capability can bypass either final boundary.

Portal consent and first-contact trust answer different questions. Portal
consent selects the collection and permissions. First contact proves that the
application installation and local connector comparing the code hold the keys
being bound. First contact applies to direct and relayed access to a
computer-owned collection, not to hosted-only grants or computer/account login.

## Trust-boundary map

| Boundary | Final security decision | Primary implementation |
| --- | --- | --- |
| Application authorization | Installation signature fixes the requested ceiling | `crates/connect-protocol/src/first_contact.rs` |
| First contact | Local connector persists exact installation trust after independent code comparison | `crates/connect-core/src/registry/application_trust.rs` |
| Encrypted relay | Connector decrypts and rechecks its locally cached exact grant | `crates/connect-agent/src/server/operations.rs` |
| Local filesystem | Connector applies canonical path, resource, file, scope, and grant policy | `crates/connect-core/src/registry/grants.rs` |
| Control plane | Portal consent narrows authority; routing checks fail closed | `services/server/src/features/authorizations/approval-service.ts` |
| Hosted provider | Provider validates exact capability and proof before execution | `crates/connect-hosted-provider/src/provider/capabilities.rs` |
| Managed wrapping | Exact KMS context and envelope-selected immutable key ARN unwrap a DEK | `crates/connect-hosted-provider/src/key_wrapping/aws.rs` |
| Release integrity | Immutable tag, pinned workflow, checksums, signatures/attestations, explicit unsigned labels | `.github/workflows/desktop-release.yml` |

The machine-readable package lists every supporting source, regression test,
shared cross-runtime fixture, and reproduction command. Its test fails if a
referenced file disappears or a required boundary or limitation is omitted.

## Cryptographic review targets

The custom protocol surface should receive independent cryptographic review.
Its implemented constructions are:

- application authorization: P-256 ECDSA/SHA-256 over a domain-separated,
  length-delimited transcript, with canonical 64-byte IEEE-P1363 low-S
  signatures and distinct installation/grant agreement/signing keys;
- first contact: P-256 ECDH, transcript-bound HKDF-SHA-256, and 40 output bits
  shown as `XXXX-XXXX` Crockford Base32 on independently controlled displays;
- relay: P-256 ECDH, separate request/response HKDF-SHA-256 keys, and
  AES-256-GCM whose nonce and associated data bind a monotonic counter and the
  complete grant/routing context;
- hosted content: a random 256-bit per-collection DEK, AES-256-GCM with random
  96-bit nonces and kind-specific associated data, plus HMAC-SHA-256 path
  tokens for equality lookup;
- hosted request proof: P-256 ECDSA/SHA-256 binding method, target, body and
  credential digests, timestamp, and UUID nonce; and
- managed wrapping: AWS KMS encrypt/decrypt of DEKs only, with an immutable key
  ARN in the envelope and exact service, environment, purpose, collection, and
  version encryption context.

The Rust and TypeScript implementations share versioned fixtures for
application authorization, first contact, record/file encryption, and relay
file framing. Reviewers should still verify transcript ambiguity resistance,
ECDSA malleability handling in each runtime, counter allocation and exhaustion,
replay persistence, error equivalence, downgrade behavior, and key lifetime.

## Data visibility and key lifecycle

The control plane may observe opaque routing identities, exact grant policy,
the operation name, counters, timing, network metadata, and bounded ciphertext
sizes. It must never receive or persist absolute local paths, local record/file
payloads, or relay input/result plaintext. Tokens, private keys, unwrapped DEKs,
credentials, proof signatures, and content must not enter logs, traces, crash
reports, or support artifacts.

For standard hosted collections, the provider can decrypt by design. PostgreSQL
stores ciphertext and wrapped per-collection DEKs; AWS KMS receives only DEKs
and their authenticated context, never collection content. The staging
KMS lifecycle has been exercised through initial activation, complete V1-to-V2
rewrap, cold operation with V1 disabled, workload credential replacement and
rejection, and full semantic acceptance. The retained old key is a recovery
artifact and is unavailable to the active workload. The full clean-environment
database/object/KMS-replica recovery drill remains an explicit open gate.

## Reproduction

Start from a pinned commit with the checked-in lockfiles, then run the commands
in `config/security-audit-package.json`. The minimum full request-path set is:

```sh
cargo test --workspace
pnpm typecheck
pnpm test
pnpm e2e
pnpm e2e:relay
pnpm e2e:provider
pnpm e2e:files
pnpm e2e:desktop:container
pnpm test:browser-storage
pnpm package:audit
pnpm check:release-readiness
```

Live evidence must name an immutable application commit/image digest and a
specific infrastructure commit. It should be aggregate-only, redact credentials
and identifiers not needed for review, preserve failures as well as successes,
and distinguish staging from production.

## Known limitations and review priorities

The complete limitation register is machine-readable. The highest-priority
items are:

- no independent security audit has occurred;
- endpoint compromise and plaintext already delivered to an authorized app are
  outside the confidentiality claim;
- the relay leaks documented traffic metadata and has one broker service;
- standard hosted mode trusts the live provider; private/zero-knowledge hosting
  is not implemented;
- the 40-bit first-contact value requires an accurate human comparison across
  independent endpoint displays, and there is no append-only key-transparency
  log;
- future native SDK key storage still needs platform-keystore integration;
- Render uses narrowly scoped, rotated static AWS credentials rather than
  workload identity federation;
- full isolated recovery and platform signing/notarization remain open release
  gates; and
- recovery administration currently depends on one operator.

An assessor should prioritize authorization-ceiling confusion, substituted-key
first contact, replay/counter persistence, relay metadata tampering, local-path
materialization, hosted proof/capability confusion, ciphertext identity swaps,
KMS context/key-reference substitution, rotation interruption, recovery without
the original context, secret-bearing diagnostics, and release artifact
substitution. Findings should include the source location, exploit preconditions,
impact, and a reproducible regression test.
