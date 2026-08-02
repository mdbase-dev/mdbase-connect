# @mdbase-dev/connect-dev

Developer tools for applications built on mdbase connect.

The package provides canonical manifest and data-contract validation plus an
in-memory transport for frontend tests. The sandbox supports typed CRUD,
revision preconditions, read defaults, type-filtered pagination, and change
cursors. It rejects CEL filters and ordering so semantic tests cannot silently
depend on an approximation; run those against a real connector.

```ts
import { createSandbox } from "@mdbase-dev/connect-dev";

const { client } = createSandbox({
  records: [{
    path: "tasks/first.md",
    types: ["task"],
    frontmatter: { type: "task", title: "First" }
  }]
});

const tasks = await client.query({ types: ["task"] });
```

Validate artifacts from a project script:

```sh
mdbase-connect-dev validate-manifest public/.well-known/mdbase-app.json
mdbase-connect-dev validate-manifest public/.well-known/mdbase-app.json --allow-local
mdbase-connect-dev validate-contract worklog-contract.json
```

Bundled application declarations support connector-controlled type-pack
provisioning. Put the contract, its implementing types, and any referenced
schemas in one `provisions.type_packs` transaction. Each manifest entry pins
the exact destination and SHA-256 digest. `provides` declares which exact
contracts the pack satisfies; auxiliary types belong in the same pack. The
validator rejects missing sources, digest mismatches, and claims for contracts
the application does not require.

Use `defineTypePack` to generate the manifest entries and digests from readable
documents:

```ts
import { defineTypePack } from "@mdbase-dev/connect-dev";

const provision = defineTypePack({
  id: "example.tasks",
  version: "1.0.0",
  resources: [
    {
      kind: "contract",
      mode: "managed",
      source: "_contracts/example.task.md",
      document: contractDocument
    },
    {
      kind: "type",
      mode: "seed",
      source: "_types/task.md",
      document: typeDocument
    }
  ]
});
```

The helper validates each contract document and derives the exact semantic
`provides` descriptors. Managed resources evolve with the pack; seed resources
become collection-owned after their initial creation.

Native applications may add a reverse-domain private-use callback scheme that
matches the v1 manifest's application ID, such as
`example.tasks.desktop://auth/mdbase/callback` for
`id: "example.tasks.desktop"`. Native authorization still uses PKCE and should
open the authorization URL in the system browser.
