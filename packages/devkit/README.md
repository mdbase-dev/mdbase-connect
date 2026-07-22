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

Application manifests support connector-controlled type provisioning. Put the
complete portable type document in `provisions.types`, declare the contracts it
provides, and list the same contracts under `requirements.contracts`. The
validator rejects provisions for contracts the application does not require.

Native applications may add a reverse-domain private-use callback scheme that
is bound to the manifest publisher, such as
`example.tasks.desktop://auth/mdbase/callback` for a manifest hosted at
`tasks.example`. Native authorization still uses PKCE and should open the
authorization URL in the system browser.
