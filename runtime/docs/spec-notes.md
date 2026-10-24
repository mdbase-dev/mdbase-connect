# Spec notes: gaps and interpretations in the rc.5 draft

**Errata.** A provisional rc.5 errata branch for mdbase-spec covers N1, N9,
N15, N16, N18, N19, N20, N21, N26, N29, N32, N33, N34 and N37. The core
already follows it; for N21 the errata changed the rule, and the core now
follows the new one. Notes stay here until the errata merge.

Status: maintained alongside `mdbn-core`. Each note names the spec text (rc.5
draft, branch `spec/v0.3.0-rc.5-draft`), what is ambiguous or where the
executable model (`scripts/concurrent_edits_model.py`) disagrees with the prose,
and what the core does. Where the model and the prose disagree, the core follows
the prose, as the model's own docstring says. Items marked **(spec change?)**
probably deserve normative text before 0.3.0 stable.

## Query ordering change (chapter 11)

The new shared device/DO index uses a deterministic total kind order:
boolean, exact number, explicitly schema-typed date/date-time, text, list, map,
then missing/null. DESC reverses kind/value order (null first); record ID is the
final ASC tie-break in either direction. Lists/maps compare by length. Plain
strings are not guessed to be dates; invalid declared temporal strings remain
text. This replaces incompatible-kind-equals and the old path tie-break.

Release integration must use the same atom codec for SQL and in-memory paths,
with differential conformance. The initial codec/heap PR is draft until typed
query and legacy ID-tie wiring are complete. Normative public spec text still
needs the spec owner's matching update; read-only vendored fixtures are not edited.

## YAML profile (chapter 03)

**N1. Scalar resolution schema is unspecified. (spec change?)** Chapter 03 asks
for "a safe YAML parser" and says common scalar forms SHOULD be normalized into
the JSON data model, but does not say which YAML schema resolves plain scalars.
YAML 1.1 and 1.2 disagree on `yes`/`no`/`on`/`off`, `0777`, `1_000`, `1:20`
and timestamps. The model uses PyYAML's YAML 1.1 safe loader with timestamps
removed, so for the model `yes` is `true` and `0777` is 511.
*Core:* the YAML 1.2 core schema (null, booleans in three spellings, decimal /
`0o` / `0x` integers, decimal floats); everything else, timestamps included, is
a string. No fixture depends on the difference. When the writer has no previous
style to keep, it quotes strings that a YAML 1.1 tool would read differently
(`"yes"`, `"2026-10-01"`), so other tools read the same value.

**N2. Non-JSON scalars.** Chapter 03 says NaN, infinities and similar values
"MUST be handled by the mdbase YAML profile before schema validation or
rejected". *Core:* `.inf`, `.nan` and decimal numbers whose value is not a
finite `f64` (`1e999`) resolve to the string as written. Integers beyond `i64`
become the nearest float.

**N3. Duplicate keys.** Not mentioned. PyYAML (the model) keeps the last value
silently. *Core:* a duplicate key makes the YAML invalid
(`invalid_frontmatter`, reason `yaml_syntax`): silently dropping a value would
break "never silently discard", and an entry-based writer cannot patch a key
that has two entries.

**N4. Reason code for YAML syntax errors. (spec change?)** Chapter 03 defines
`details.reason: non_mapping_frontmatter` only. *Core:* `yaml_syntax` for
frontmatter that does not parse under the profile.

**N5. Constructs outside the profile.** *Core* reports these as YAML errors
rather than guessing: directives, more than one document, explicit keys (`? `),
collection or alias keys, anchors or tags on block mapping keys, tabs as
indentation, carriage returns not followed by a line feed, tags other than
`!`, `!!str`, `!!int`, `!!float`, `!!bool`, `!!null`, `!!seq`, `!!map`
("MUST NOT execute custom tags"). The YAML 1.1 merge key `<<` is an ordinary
key, as in YAML 1.2.

**N6. Non-string mapping keys.** JSON keys are strings; YAML keys need not be.
*Core:* a plain key is taken as written (`1:` is `"1"`, `null:` is `"null"`), a
quoted key by its value.

**N7. Resource limits. (spec change?)** None are specified. *Core:* nesting
depth at most 100 and alias expansion at most 100,000 value nodes per document
(alias bombs are rejected). Both limits are deterministic, so every replica
accepts and rejects the same files. A different engine with other limits could
disagree on pathological files.

**N8. Leniencies.** The core accepts a flow collection's closing bracket at the
start of a line at the parent's indentation (`tags: [a,\n]`), which YAML 1.2
forbids but js-yaml and PyYAML accept. A block scalar at the end of the input
without a final line break is clipped to no line break (the YAML spec and
PyYAML; yaml-rust2 adds one).

## Writer format fidelity (chapter 12A)

**N9. Which lines belong to an entry.** 12A: an entry is the key line "together
with every following line that belongs to that key's value", and blank and
comment lines at column 0 between entries belong to no entry. Unclear cases:
- *Indented comment lines directly after a value* (`tags:\n  - a\n  # about a`).
  *Core:* part of the entry (as in the model, which treats every indented line
  as a continuation). Blank lines between the value and such a comment go with
  it; trailing blank lines do not.
- *A column-0 comment inside a block sequence* (`tags:\n- a\n# c\n- b`). The
  model's line splitter ends the entry at `# c` and turns `- b` into an
  interstitial line, so re-emitting `tags` would leave a stray `- b`. *Core:*
  the entry runs to the end of its value as parsed, so `# c` and `- b` belong to
  it.

**N10. Frontmatter that is a flow mapping** (`---\n{a: 1, b: 2}\n---`). It has
no entries, so rules 1–5 cannot apply. *Core:* a write re-emits the whole
mapping in block style.

**N11. Entries tied by anchors and aliases.** Changing or removing an entry
that defines an anchor would change or break the entries that alias it. 12A
does not say what to do. *Core:* every write is verified by parsing it back;
entries whose value would change are re-emitted from their values (aliases are
expanded), and every other entry stays byte-identical.

**N12. Mixed line endings.** Rule 6 keeps "the line ending style". *Core:* the
style is that of the opening delimiter line (the first line ending of a YAML
document record or of a file without frontmatter). New and re-emitted entries
use it, and an entry copied from another version (rule 5) has its line endings
converted. The model uses `\r\n` if the source contains any.

**N13. A new key when there are no entries.** Rule 4 puts a new key after the
last entry. With no entries (only comments, or empty frontmatter) the model
inserts it at the start. *Core:* same.

**N14. Re-emitting a value whose kind changed.** Rule 3 covers a collection
that stays a collection. *Core:* when the kind changes (scalar to list, list to
map), the new value uses the default styles (lists of scalars in flow style,
other collections in block style), keeping the gap after `:` and the trailing
comment.

## Paths (chapters 02, 07)

**N15. Unicode version of path keys. (spec change?)** Path keys depend on NFC
and case-folding tables, and the spec does not pin a Unicode version. Unicode's
stability policies keep both stable for assigned characters, but a character
assigned in a later version can fold differently once both sides know it.
*Core:* NFC and full case folding from Unicode 17.0.0 (a test fails if the NFC
crate and the generated folding table disagree).

**N16. "JSON representation" of a float in a path pattern. (spec change?)**
Chapter 07 converts numbers with "their JSON representation", which differs
between serializers (`42.0` is `42.0` in Python and `42` in JavaScript; `1e21`
is `1e+21` or `1000000000000000000000`). *Core:* RFC 8785 (ECMAScript
`Number.prototype.toString`), so `42.0` gives `42`. The fixture uses an integer.

**N17. A malformed path pattern** (an unclosed `{`, or `{}`) is not covered.
*Core:* an error (`invalid_type`, since the type definition is at fault).

## Three-way merge (chapter 12A)

A local differential run (`scripts/diff-merge-model.py`) compares the core with
the executable model on 20,000 generated cases. Documents agree byte for byte
and conflicts agree exactly. The notes below cover cases outside that run.

**N18. Conflict order.** The suite README lists conflicts "in frontmatter key
order, then frontmatter, body, path"; the model puts a path conflict first.
*Core:* the README's order. "Frontmatter key order" is itself unspecified when
the versions order keys differently; the core (like the model) takes the first
version's keys, then keys only in the second, then keys only in the base.

**N19. A `type_conflict` between merge declarations during a merge.** Chapter
05 says conflicting collection behavior is detected "before applying the
affected behavior" and a write fails, but a merge of concurrent edits cannot
fail. The model raises an exception. *Core:* the field merges with the
`conflict` strategy, which never loses a value. Reading the record reports the
`type_conflict` as chapter 05 requires.

**N20. LCS choice. (spec change?)** 12A leaves the choice between several
longest common subsequences open and recommends Myers, but Myers variants
(greedy forward, linear-space bisection) choose differently too, and the
model uses a dynamic-programming LCS with its own tie-break. *Core:*
linear-space Myers with the middle-snake bisection of diff-match-patch. Pinning
one alignment (for example "the greedy forward Myers path") would make body
merges reproducible across engines.

**N21. Append-append when the base has no final line break. (errata: fixed)**
Read literally, base `a`, first `a\nb`, second `a\nc` merge to `a\nb\n\nc`:
both sides "begin with all of B", `first`'s appended text `\nb` lacks a final
terminator, so a `\n` is inserted, and `second`'s `\nc` adds its own. The core
follows the text. Treating a final line without a terminator as unterminated
(appends continue it) would avoid the empty line.

**N22. Non-mapping frontmatter as one unit.** "The whole frontmatter is one
unit" does not say what the unit's text is. *Core:* the frontmatter block
including its delimiters, compared as text; a version whose YAML does not parse
counts as not a mapping too. Taking the second version's unit replaces the block
and keeps the first version's byte-order mark.

**N23. Leap seconds in `max`/`min`.** RFC 3339 allows second 60. *Core:*
`23:59:60` is the instant one second after `23:59:59`, equal to the next
`00:00:00` under the ordering (so the first value is kept). The model's Python
`datetime` rejects it and compares the strings as text.

## Move detection (chapter 12A)

**N24. Lines for similarity.** "Each file's lines are trimmed of leading and
trailing whitespace": which whitespace, and which line breaks? The model uses
Python's `splitlines()` (which also breaks at `\v`, `\f`, `\x1c`–`\x1e`, NEL,
LS and PS) and `strip()`. *Core:* lines end at `\n` (as in the body merge),
and trimming removes Unicode White_Space. Similarities are compared as exact
fractions, so the 0.5 and 0.8 thresholds are exact.

## Body edits (chapters 12, 12A)

**N25. When the current body is the base.** The model applies the edits to
the current body whenever its digest equals `body_base`, even if the engine
holds no separate copy of the base. *Core:* the same. The planner passes
`BodyBase::Text(current)` when the digests match.

## Regex profile (chapter 10)

`mdbn_core::regex` validates every pattern against the profile's syntax list
before compiling it with `regex-lite`. A randomized test (soaked at 2,000,000
patterns) checks that every pattern the validator accepts also compiles in
`regex-lite`.

**N26. `\<` and `\>`. (spec change?)** The profile allows "`\` before any ASCII
punctuation character" as a literal, but `regex-lite` (whose semantics the
profile names) reads `\<` and `\>` as word boundaries, while RE2/Go read them
as literals. *Core:* literals, per the syntax list; they are rewritten before
compilation.

**N27. Constructs `regex-lite` accepts but the profile does not list.**
*Core:* invalid. These are `\b{start}` and the other `\b{...}` forms,
`(?<name>...)`, the `U` and `R` flags, `\a`, `\u`/`\U`, and escapes of
non-punctuation (including `\ `, an escaped space: in verbose mode a space is
written `\x20`). The profile's "anything else is invalid" makes this the
literal reading, but `regex-lite` users might expect them.

**N28. Characters RE2 takes literally.** RE2 treats a `{` that does not start a
valid repetition, and a `]` or `}` outside a class, as literals. The profile's
list does not mention them. *Core:* invalid (escape them). Rejecting is safer
than guessing, and an unescaped `{` is usually a typo.

**N29. Limits. (spec change?)** None are specified, and `regex-lite`'s own
size limit is computed from `usize`-sized states, so it could accept a pattern
natively and reject it in WASM. *Core:* deterministic limits instead: 8,192
bytes, nesting depth 64, repetition counts at most 1,000 (as in RE2), and an
estimated program size of at most 100,000 after expanding counted
repetitions.

**N30. Errors RE2 also reports.** Duplicate group names, a class used as a
range endpoint (`[\w-z]`) and out-of-order ranges are invalid. Nested classes
(`[a[b]]`) and class set operations (`&&`, `--`, `~~`) are invalid as well,
since the profile lists only simple bracket classes.

**N31. The `x` flag.** RE2 has no verbose flag. The profile lists it with
`regex-lite` semantics: whitespace and `#` comments are ignored everywhere,
inside bracket classes included. *Core:* same.

## CEL profile (chapter 10)

**N32. `lower()`/`upper()` and the Unicode version. (spec change?)** "Unicode
default full case mappings without locale tailoring" leaves two choices open:
whether the context-dependent final-sigma rule applies (`"ΣΑΣ".lower()`), and
which Unicode version is used. *Core:* Rust's `str::to_lowercase` and
`to_uppercase`, which apply final sigma. They use the toolchain's Unicode
tables, which are pinned with the toolchain (`rust-toolchain.toml`) but not
with the path-key tables (N15).

**N33. Map iteration order.** CEL maps are unordered, but `map`, `filter` and
`all`/`exists` over a map visit its keys in some order, and `map` returns a
list in that order. *Core:* insertion order: frontmatter order for record
values and source order for literals. Deterministic, but another engine could
order differently.

**N34. Text of `string(double)`.** CEL does not fix it. *Core:* RFC 8785 /
ECMAScript text (`1e+21`, `0.3333333333333333`, and `0` for negative zero),
the same as path patterns (N16).

**N35. Evaluation work.** Hosts SHOULD bound evaluation. *Core:* at most
1,000,000 evaluation steps (each node visit and each comprehension iteration
counts); exceeding it is an evaluation error, the same on every platform.

**N36. Unknown functions.** Hosts MAY type-check. *Core:* calling a function
the engine does not implement is a compile error. Today that covers the
profile's timestamp, duration, date and file/link helpers (named in the
error), so an expression never compiles and then fails at evaluation for that
reason.

**N37. `cel/cel-profile.yaml` has no test ids.** The ratchet keys fixtures by
`id`, so that file cannot be vendored yet; its tests should get stable ids like
the rc.5 files.

**N38. Time zone data. (contracts Q6, decided 2026-10-04)** `date(timestamp)`,
`startOfDay()` and calendar conversions use compact, embedded IANA **2026e**,
including all 597 names, historical transitions and POSIX future rules.
Semantics **1.1** names the release; 1.0 remains a diagnostic registry row.
`NamedZone::get` and `lifecycle::cel_clock` never consult host zoneinfo. Unknown
zones are explicit `unsupported_timezone` evaluation errors, not UTC fallbacks.
`now()` and `today()` still read the captured instant and local date.

The official `tzdata2026e.tar.gz` SHA-256 is
`b26882805f26aac59d5b222978e6580484b834ccdc98be89df2f05a6dc53a652`.
`scripts/gen-tzdb-table.py` compiles that release with `zic -b slim` (2026d),
deduplicates rule sets, varint-encodes deltas and offsets and raw-DEFLATEs the
133,161-byte table to 27,134 bytes. The generated bytes define the semantics.
`scripts/gen-tzdb-oracle.py` reads the pinned compiled files with Python
`ZoneInfo.from_file`; 5,397 offset cases cover every name, history, DST boundaries
and far-future rules. Existing `Tzif` remains an independent reader interface.
The allowance is at most 40 KB added gzip, without weakening CI.

**N39. `startOfDay` in a gap.** When local midnight is skipped (America/Santiago
starts DST at 00:00), the spec's "start of that date" is ambiguous. *Core:*
the first instant whose local date is that date, i.e. the transition. When
midnight occurs twice, the earlier one.

**N40. Timestamp accessors with a zone argument.** CEL's `getHours("tz")` etc.
accept exact, case-sensitive IANA names and aliases from the embedded release
(N38), as well as fixed offsets (`"+10:00"`, `"UTC"`). With no argument they use
UTC, independently of the invocation zone. Unknown names and malformed offsets
are evaluation errors.

**N41. `file.hasTag` and `file.inFolder` details.** Chapter 08 defines tag
prefixes by segment, but not case or the `#` prefix. *Core:* `#` is optional on
both sides, and matching is case-sensitive. `inFolder` ignores leading and
trailing `/`, and `inFolder("")` is true for every record.

**N42. Durations.** CEL defers to Go's `time.ParseDuration`. *Core:* that
grammar exactly (`"1.h"`, `"0"`, `µs`), within CEL's ±10,000-year range.

## Path safety

**N43. The portable path policy. (spec change?)** Spec 02 requires rejecting
paths that escape the root and lets implementations reject reserved names;
`intent.md` §3.7 requires a portable path policy that every replica applies
identically. Neither lists the rules. *Core:* `paths::check_path` enforces this
policy. Spec 02 should probably list these rules, so that every tool rejects the same paths. The
choices beyond the listed rules:
- rejecting NTFS 8.3 short-name shapes and HFS+-ignorable code points (git's
  CVE-2014-9390 class);
- a 1,024-byte path limit;
- comparing `.mdbase` and `node_modules` by a fixed rule (ASCII case plus
  `ſ` and `K`), independent of the Unicode version.

The rc.5 errata (mdbase-spec #62) adds these rules to Chapter 02.

**N44. CEL edge semantics, checked against cel-go.** A 200,000-case differential
against cel-go (`tools/cel-diff`) pinned some details the CEL text leaves to
implementations:
- runs of unary operators cancel in pairs (`--x` is `x`);
- `uint(d)` is an error for any negative `d`;
- `int(d)` is an error at exactly -2^63;
- `string(timestamp)` writes only the fraction digits it needs.

Durations keep CEL's ±10,000-year range and exact `string(duration)` digits,
where cel-go is limited by Go's int64 nanoseconds and float formatting.

**N45. The implementation digest's `type.schema`. (spec change?)** Spec 05A says
contract digests use "the fully resolved JSON Schema values rather than their
storage wrappers or reference paths", and it lists `schema` among the
implementation digest's type members without saying which form. The reference
checker (`scripts/check_v03_tests.py`) and the fixture digest
(`data-contract-implementation-digest`) use the type's `schema` member **as
written**, wrapper included (`{dialect, value}` or `{dialect, ref}`). So a `ref`
change alters the digest, while edits to the referenced file do not. *Core:*
follows the fixture. The spec should state the form, preferably the resolved
schema, as for contracts.
