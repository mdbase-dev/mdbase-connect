# Native collection management discovery

The authenticated `/v1/me` response includes `native_collections`: collection ID,
nullable shared display name, configured private/cloud-copy sync mode, and the
current management relationship, role and member-management flag. No local path,
record data, key, endpoint, device credential or application content grant is
included. A null name is displayed as “Unnamed collection”, not inferred from a
retained label or a device's local path.

Visibility uses native collection runtime independently of the owner's account
backend. Canonical sharing authority checks current ownership, suspended owners,
leave-sync and deletion; nonowners must have an exact active policy permitting
collection discovery. Frozen owner/requester migration topology keeps metadata
visible but disables the member-management flag. Every mutation still performs
its existing current-authority checks under the canonical transaction locks.

A runtime-next registry row supersedes retained hosted/local catalog entries even
when the native authority is unavailable; it never revives a legacy management
surface. Shadow runtime continues to expose its actual legacy authority.

The inventory refuses more than 1000 native candidate collections with
`collection_inventory_limit` instead of silently presenting a partial chooser.
Management can select a registry-only collection and reuse the existing sharing
routes and controls. It does not advertise legacy provider mirror, rename or
delete actions for native entries, nor infer replica read health from visibility.
Applications still require their separate collection approval.

The management client's optional `native_collections` field supports existing
control planes predating this additive response. Those responses continue to
show their legacy inventory; the optionality can be removed once supported
control-plane versions all include native discovery.
