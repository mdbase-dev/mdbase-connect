# Hosted Candidate B consumer staging missions

Status: inventory frozen; execution pending isolated synthetic staging

These missions validate the selected Candidate B architecture without production
fallback. Every deployment uses a synthetic collection, a staging-only authority,
and an explicit check that no beta/production endpoint or collection ID is present.
Passing unit tests is not a substitute for the live mission.

## Shared gates

Every consumer must exercise:

- exact point read and default projection-only query;
- deterministic cursor pages, changed first/subsequent page sizes, early release,
  reconnect, expired cursor, and snapshot-head stability across a concurrent write;
- body predicate/output with measured exact-document count and typed budget failure;
- create/update/rename/delete revision CAS and reconnect/retry receipt behavior;
- wikilink, Markdown link, embed, alias, anchor, relative and ambiguous target
  behavior plus backlinks/reference preflight;
- cancellation during SQL, residual evaluation, and response streaming, followed by
  independent pool/transaction/permit/plaintext-release probes; and
- projection rebuild restart, lease fencing, stale/absent union, authorization
  narrowing/widening, and fail-closed canonical classification.

The mission records request/response fixtures, provider and PostgreSQL metrics,
cursor/rebuild state, exact documents decrypted, and cleanup observations. No
consumer may silently switch to a mirror or filesystem authority.

## Connect SDK and generic operations

Preflight commands:

```text
pnpm install --frozen-lockfile
pnpm build:packages
pnpm check:architecture
pnpm check:operations
pnpm check:problems
pnpm typecheck
pnpm test:fast
pnpm test:integration
pnpm --filter @mdbase-dev/connect test:consumer-spikes
pnpm --filter @mdbase-dev/connect test:public-api
pnpm e2e:provider
pnpm check:consumer-artifacts
```

The live mission covers `describe`, `read`, `query`, `queryPages`, `queryAll`,
cursor release, `changes`, all four record mutations, saved-view operations, and
generic MCP transport. It verifies snake/camel wire mapping, typed budget problems,
per-page deadlines, abort signals, and the public result envelope.

## TaskNotes

Run the repository typecheck, unit, conformance, end-to-end, and production-smoke
suites before `pnpm deploy:dev`. Seed more than 1,000 deterministic tasks spanning
status, dates, priorities, contexts, projects, recurrence, malformed frontmatter,
body tags, and relationship syntax. Exercise realistic list/filter/order pages,
exact hydration, optimistic writes, backlinks, cancellation, reconnect, and rebuild
recovery.

## mdbase-reader

Run `pnpm check`, `pnpm check:architecture`, `pnpm check:spec`, and `pnpm test`, then
deploy with `MDBASE_READER_DEPLOY_TARGET=staging pnpm deploy:dev`. The staging
deployment must resolve to the dedicated `mdbase-reader-staging` Pages project and
`staging` branch; the public Reader project is not an acceptable staging target. Validate
`queryPages`, exact/body search, delete preflight, body/link rendering, typed limits,
and no production fallback. Mutation, asset, saved-view, and delete-preflight calls
must propagate cancellation and explicit request budgets, and pending durable
mutation receipts must recover successfully before canonical state is loaded.

## mdbase-editor

Run typecheck, unit, deployment, and end-to-end suites. Validate 200/1,000-item page
transitions, exact `hydrateContent`, snapshot stability, watch/change reconnect,
optimistic write conflicts, relationship edits, and cancellation. The repository's
vendored beta.33 SDK is an explicit compatibility risk: upgrade or prove its wire
behavior before the mission can pass.

## Pickle

Run the package verification, Connect end-to-end, and Android smoke commands.
Validate request/response links, inbox queries, point hydration, state transitions,
and reconnect through Pickle's hosted SDK wrapper. Test MCP relationship/link
representation separately rather than assuming local filesystem semantics.

## MCP

Exercise local server and hosted transport development workflows with the same
synthetic authority. Cover generic query/read/mutate tools, pagination, cancellation,
transport reconnect, typed errors, exact document opt-in, and relationship results.
Capture the advertised operation schemas and reject any legacy WorkingSet-only
shape.

## Cloud operations and recovery

Run cloud-ops read-only tests and `bin/verify-staging candidate` before mutations.
Deploy only the isolated Candidate B stack. Exercise provider restart during each
rebuild phase, expired/stolen leases, fencing loss, cursor cleanup, database
cancellation, outbox/notification recovery, backup inventory, and rollback to a
binary that ignores the additive schema. Do not activate an existing collection.

## Evidence and acceptance

Each mission produces a committed manifest naming repository SHA, deployment ID,
synthetic fixture digest, authority/collection IDs, start/end time, operations and
counts, typed failures, metrics artifact paths, and cleanup proof. A mission fails
on any semantic/security mismatch, ambiguous mutation outcome, unexplained
production connection, missing cleanup observation, or budget success reported as
ordinary completion.
