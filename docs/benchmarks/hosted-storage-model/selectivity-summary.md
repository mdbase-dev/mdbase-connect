# Frozen canonical workload selectivity

Status: oracle-verified Phase 1 evidence. Candidate rows are exact semantic matches
for the closed workload expression before client residuals/transforms; consumer
results are after the frozen Reader/Pickle joins and other residuals, but before a
non-repeating response page limit. SQL candidate-superset rows and scanned rows are
Phase 3 measurements and are not inferred here.

| Workload | 10k candidate / consumer | 100k candidate / consumer | ~1 GiB candidate / consumer |
| --- | ---: | ---: | ---: |
| TaskNotes selective open project | 23 / 23 | 226 / 226 | 522 / 522 |
| TaskNotes broad active | 1,909 / 1,909 | 19,061 / 19,061 | 43,864 / 43,864 |
| TaskNotes completion | 10 / 10 | 20 / 20 | 120 / 120 |
| TaskNotes tag + due range | 345 / 345 | 3,468 / 3,468 | 7,979 / 7,979 |
| TaskNotes group/status | 3,500 / 3,500 | 35,000 / 35,000 | 80,563 / 80,563 |
| Editor metadata index | 10,000 / 10,000 | 100,000 / 100,000 | 230,128 / 230,128 |
| Editor one body page | 10,000 / 10,000 | 100,000 / 100,000 | 230,128 / 230,128 |
| Reader source library / `reading` residual | 1,485 / 296 | 14,850 / 2,969 | 34,170 / 6,829 |
| Reader common-body / merged source results | 2,000 / 495 | 20,000 / 4,950 | 46,026 / 11,390 |
| Reader annotations for `src_0000042` | 990 / 1 | 9,900 / 1 | 22,780 / 1 |
| Pickle all join rows / requests | 1,485 / 990 | 14,850 / 9,900 | 34,176 / 22,781 |
| Pickle all join rows / pending requests | 1,485 / 940 | 14,850 / 9,405 | 34,176 / 21,642 |
| MCP selective notes | 330 / 330 | 3,300 / 3,300 | 7,593 / 7,593 |
| SDK selective metadata | 330 / 330 | 3,300 / 3,300 | 7,593 / 7,593 |
| SDK selective body needle | 2 / 2 | 11 / 11 | 24 / 24 |
| Absent cancellation needle | 0 / 0 | 0 / 0 | 0 / 0 |
| Absent contention needle | 0 / 0 | 0 / 0 | 0 / 0 |

The group workload has six canonical keys because malformed opaque TaskNotes-path
records retain their path-only `task` classification but have no effective status;
the null group is intentional and frozen. Reader/Pickle records whose type matching
requires missing frontmatter facts become untyped when malformed.

Exact ordered record-ID, response-field, provider-page, consumer-page, group, and
completeness digests are in:

- `fixtures/records-10000/expected-results.json`;
- `fixtures/records-100000/expected-results.json`; and
- `fixtures/canonical-1gib/expected-results.json`.

The tiers contain 10,000 / 46,208,841 bytes, 100,000 / 465,653,392 bytes, and
230,128 / 1,073,743,117 canonical Markdown bytes. The large tier exceeds the
1-GiB threshold by 1,293 bytes. Every expected artifact was recomputed by mdbase-rs
`e3cf57e9feb6e31f17cbf0ce21d70646ee908edb` and exactly matched the independent
JavaScript seed before promotion.
