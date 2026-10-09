# Legacy archive prefix compatibility

The closed v4 admission fields and trusted verifier boundary are unchanged. New
legacy physical locations may use
`legacy-archive/<staging|production>/YYYY/MM/DD/ID`; historical environment-first
`<staging|production>/YYYY/MM/DD/ID` locations remain readable under the same
freshness, binding, original timing and exact 116-day retention rules.

The environment comes from the canonical validated prefix match, not its first
path segment. The full physical prefix is preserved: no stripping, relocation,
receipt/digest rewriting or timestamp resampling. A new namespaced location is
not interchangeable with an already accepted historical receipt; conflicting
admission for the same revision remains refused. Existing receipt rows remain
immutable.

`routine/` locations never qualify as legacy H0 admission, regardless of a
retention caption. Namespace selection belongs to the trusted producer profile,
and the enclosing verifier must bind the actual physical payload keys, signature,
digests and retention. CP parsing alone is not cryptographic/provider evidence.

Considered the existing v4 prefix schema and identity/currentness checks; adapted
only their grammar and environment extraction, without another header or parser.
Producer/ONE source qualification and separately authorized operations remain
required; this compatibility change does not reopen capture/verification guards,
create a new endpoint/token/store or grant capture, restore or live-operation GO.
