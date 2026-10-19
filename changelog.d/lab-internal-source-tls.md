## Fixed

- Keep LAB internal migration-source PostgreSQL connections encrypted without pinning Render's rotating self-signed certificate. Source identity and read-only checks remain in place; staging, production, and ordinary database TLS policy are unchanged.
