# SDK: multiple vaults on one origin

Give each vault a stable, distinct `storage.applicationNamespace` (different
from the application ID). The SDK scopes tab/Worker grouping, pre-account
sign-in locks, protected installations and Private grants to that namespace.
Each vault pairs independently and receives its own installation/device IDs;
the existing device-key stores and OPFS replica pools then remain separate.
Signing out erases only that namespace's installations, grants and replica data,
and evicts log tokens matching its CP/connector/device, including unlisted
collections. Other vaults stay signed in.

```ts
const vault = createMdbase({
  ...declaration,
  storage: { applicationNamespace: "obsidian-vault-<stable-vault-id>" },
});
```

Omitted join/setup database names derive from the namespace. If you override
`joinDatabaseName` or `setupDatabaseName`, keep those names distinct per vault
as well: sign-out deletes those explicitly assigned journals. Namespace changes
select fresh local storage; they do not migrate or adopt a previous installation
or grant. Previously used overrides must pair and authorize afresh after this
change. Keep the same namespace across reloads and builds.

The no-override path keeps its existing names, owners, Worker grouping and
legacy sign-in compatibility locks, including legacy whole-token-cache erasure.
A default sign-out also clears all other vaults' cached log tokens on the origin;
they re-mint them on next open.
Public verified-asset and manifest-registration caches remain shared. Namespaces
organize storage; they are not a security boundary against other JavaScript on
the same origin. Consent and grant verification remain authoritative.
