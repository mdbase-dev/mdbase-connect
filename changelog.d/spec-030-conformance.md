## Changed

- Align runtime semantics 1.3 with mdbase 0.3.0: invalid nondeterministic match types are excluded, and matching timezone conversions use only the collection's configured timezone.
- Report discovered path collisions and bind query context records with correct relative-link origins.
- Vendor the complete 0.3.0 conformance suite, measure supported artifact operations through Core, and document every unsupported case without treating missing adapter capabilities as engine failures.
