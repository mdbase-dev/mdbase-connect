# Crypto conformance vectors

Cross-implementation vectors for constructions in `docs/contracts/sealed-envelope.md` that more than one implementation computes (the Rust replica and the TS runtimes). Each file says how it was computed. Implementations assert every field.

| Dir | Construction | Checked by |
|---|---|---|
| `recovery-key/` | §5.4: recovery key text form, checksum, per-collection device keys and ID | `mdbn-replica` `crypto::tests`; obsidian-runtime `recoveryKey.ts` (text form) |
| `sas/` | §5.3: `sas_commit` and the six-digit code | `mdbn-replica` `crypto::tests`; obsidian-runtime `sasProtocol.test.ts` |
