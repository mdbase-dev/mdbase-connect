## Fixed

- Freeze a hosted migration batch before capturing its recovery archive, and fence collection creation, renaming, deletion, import, adoption, transfer and topology cleanup until the migration window permits them.
- Accept account deletion during a frozen batch and revoke its credentials immediately; automatically complete terminal erasure after the whole batch's final flip or audited unfreeze, including after a server restart. Deletion outside a freeze remains immediate.
