# Hosted execution fixtures and acceptance

The hosted execution program uses deterministic synthetic fixtures only. It never
copies production record paths, frontmatter, bodies, queries, or diagnostics into
tests or evidence.

## Fixture tiers

| Tier | Records | Intended use |
| ---: | ---: | --- |
| small | 100 | semantic and fault-injection tests |
| medium | 10,000 | ordinary staging latency and regression runs |
| large | 100,000 | default hosted scan and many-collection tests |
| acceptance | 1,000,000 | serialized `large_fixture_v1` full-scan gate only |

Each tier is a stable 50% TaskNotes, 20% Reader/literature, 20% Editor note, and
10% Pickle request mix. Ordinary documents range from roughly 350 bytes to 5 KiB.
Deterministic 64 KiB and 512 KiB long-tail records exercise batch byte limits and
large-document behavior without exceeding the hosted document quota. Editor records
contain synthetic wikilinks so later bounded link fixtures use the same corpus.

Generate an import-oriented NDJSON fixture:

```bash
node scripts/generate-hosted-execution-fixture.mjs \
  --records 10000 \
  --output /tmp/mdbase-hosted-10000
```

Use `--format directory` for a canonical filesystem collection. The generator
refuses a non-empty destination. `fixture-manifest.json` records the seed, exact
shape counts, document-byte distribution, and structural-resource sizes.

## Budget source

All harnesses read `config/hosted-execution-budgets.json`. The million-record tier
requires the test-only `large_fixture_v1` entitlement, which raises scan count,
ciphertext bytes, snapshot lifetime, and deadline to their hard maxima while
reducing the process to one active scan. The entitlement does not raise result,
ordering, grouping, diagnostic, or cursor limits.

## Evidence boundary

Reports may contain source revisions, fixture seed/tier, aggregate row and byte
counts, RSS/PSS/cgroup measurements, operation-accounted live bytes, encrypted
cursor bytes, connection occupancy, snapshot lifetime, phase timings, admission
waits, cancellation timing, typed outcome codes, and pass/fail classifications.
They must not contain generated paths or documents, raw query source, projection
values, diagnostics, keys, tokens, database URLs, or reusable content/query digests.
