## Fixed

- Read-only (`mdbase:read`) MCP authorization no longer fails with HTTP 500 before consent. Connect now accepts a signed application request that selects a subset of its declared optional file actions (every required action, declared order, same scope), and keeps exactly that signed subset as the ceiling for consent, approval and the provider grant, so an approval cannot add file actions the application did not sign. Periodic application reconciliation no longer retires grants whose approved file actions are a permitted subset of the declaration (#1103).
