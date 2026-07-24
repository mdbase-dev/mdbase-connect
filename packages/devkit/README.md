# @mdbase/connect-dev

Developer tools for applications built on mdbase connect.

The package provides canonical manifest and contract validation plus an
in-memory transport for frontend tests. The sandbox supports typed CRUD,
revision preconditions, read defaults, type-filtered pagination, and change
cursors. It rejects CEL filters and ordering so semantic tests cannot silently
depend on an approximation; run those against a real connector.

```ts
import { createSandbox } from "@mdbase/connect-dev";

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
mdbase-connect-dev validate-contract tasknotes-contract.json
```

Bundled application declarations support connector-controlled type
provisioning. Put each complete portable type document in `provisions.types`,
declare any contracts it provides, and list those contracts under
`requirements.contracts`. Auxiliary types installed with the same approved set
use an empty `provides` array. The validator rejects provisions that claim
contracts the application does not require.

Native applications may add a reverse-domain private-use callback scheme that
matches the version 3 application ID, such as
`example.tasks.desktop://auth/mdbase/callback` for
`id: "example.tasks.desktop"`. Native authorization still uses PKCE and should
open the authorization URL in the system browser.
