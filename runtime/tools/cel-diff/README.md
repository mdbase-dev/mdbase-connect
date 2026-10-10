# cel-diff: mdbn-core's CEL engine against cel-go

A local differential test (not in CI: it needs Go and network access to fetch
cel-go).

```sh
rcargo run -q -p mdbn-conformance --bin cel-diff-gen -- 50000 1 > target/cel-cases.jsonl
cd tools/cel-diff && go run . < ../../target/cel-cases.jsonl
```

`cel-diff-gen` generates random expressions over the standard CEL subset both
engines implement, and prints each with mdbn-core's result. This tool evaluates
them with cel-go and reports mismatches by category. When cel-go's type checker
rejects an expression, our evaluation error counts as agreement (spec 10 makes
checking optional); a value must equal cel-go's unchecked runtime value.

The generator stays clear of documented differences:
- map iteration order (spec note N33): maps compare as sorted entries;
- regex classes on non-ASCII text (the mdbase profile is ASCII-only);
- the profile's own functions and time zones.

Remaining differences are cel-go's, not the CEL specification's:
- Go durations are int64 nanoseconds, so cel-go errors beyond about ±292 years.
  CEL's range is ±10,000 years, and the generator keeps durations small.
- cel-go formats `string(duration)` through a float64 number of seconds, so
  it loses sub-microsecond digits. mdbn-core writes the exact digits.
- `string(timestamp)` keeps the input offset in cel-go; spec 10 serializes in
  UTC with `Z`. The generator uses UTC inputs.
- `double(18446744073709551615u) != 18446744073709551615u`: on the number line
  2^64 ≠ 2^64 − 1 (mdbn-core). cel-go converts through an out-of-range float
  cast.

Result on 2026-10-04: 200,000 cases (seeds 1–4), one mismatch, the 2^64 case
above. The run fixed four engine bugs: `string()` of a large `uint`, runs of
unary operators, `uint()` of a negative fraction, and `int()` at -2^63.
