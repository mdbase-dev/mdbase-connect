# SDK: definition errors and record validation

## Definition errors

An error-level issue on a definition the app does not declare never affects
readiness. An issue without a path always makes the collection
`incompatible`. By default, an issue on one of the app's own declared types
also makes it `incompatible`. To keep the rest of the collection usable, pass
`readiness: {typeIssues: "degrade"}`. The collection then stays `ready`, and
each affected type is listed in `readiness.assessment.unavailableTypes`
(`{name, path, contract, problem}`). Treat that type as unavailable. Show
`describeError(entry).message` for it. An error on a declared contract's own
definition always blocks.

## Persisted-record validation

```ts
const seen = await db.get(id, { include: { document: true }, signal });
const [validation] = await db.validate({ refs: [seen], signal });
// validation.id/path/revision identify the actual document validated.
for (const issue of validation.issues) {
  console.log(issue.severity, issue.code, issue.location, issue.message);
}
```

`validate({ refs?, signal? })` returns typed `RecordValidation[]` with real
Core `ValidationIssue`s, including optional location/type name and diagnostic
tier. UUID/path selections validate current native records; a `RecordView`
selection also requires the result to match that captured view's revision.
Changed revisions refuse with `record_validation_stale`; the SDK never refreshes
a witness or turns missing/refused/malformed/partial results into `[]`.
Order and duplicate selections are preserved. The original signal fences both
dispatch and final delivery, including an empty batch. Ordinary SDK read transport
policy is unchanged; no validation-specific retry or fallback is added.

This validates persisted/current local-native documents (including pending
changes), **not an unsaved draft or permission to submit/CAS a write**. A returned
revision records the version examined, not a promise that it remains current
after delivery. No types/contracts are installed implicitly. Older producers
without this operation remain real refusals, not empty success.

Selection count is at most 1000; paths are nonempty and at most 4096 UTF-8 bytes.
Native validation bounds examined documents/read work and refuses oversized
results (1 MiB/4096 issues/65536 nodes/depth 32). Omitted refs request a bounded
whole-collection inventory (at most 1000 records); some cross-record uniqueness
checks require that inventory even for an explicit record. Over-bound work is
`too_large`, never partial diagnostics. These are read/serialization bounds, not
a native peak-heap/CPU, app-intake or UI acceptance certificate.
