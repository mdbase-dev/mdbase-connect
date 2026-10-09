## Fixed

- Freeze a hosted migration batch before capturing its recovery archive, and fence collection creation, renaming, deletion, import, adoption, transfer and topology cleanup until the migration window permits them. Keep guarded transaction locks alive across bounded provider work and compensation without changing global database timeouts.
- Accept account deletion during a frozen batch, revoke its credentials immediately and terminal-exclude it from migration without changing archive membership. Automatically complete terminal erasure once the whole batch finishes or is audited-unfrozen before archive acceptance, including after a restart or a deletion accepted after the final flip. Deletion outside a freeze remains immediate.
