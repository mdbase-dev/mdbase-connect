# mdbase editor

A quiet, browser-based editor for an entire mdbase collection. It connects to a
user-approved collection through mdbase connect and works with the Markdown
records in place.

The application requests `describe`, `changes`, `read`, `query`, `validate`,
`create`, `update`, `delete`, and `rename` for one selected collection. Its
manifest declares no domain contract, so the local connector treats the grant
as collection-wide access.

## Development

The repository currently vendors pinned pre-release SDK tarballs from
`mdbase-dev/mdbase-connect` so its private Pages build is reproducible before
the packages are published to npm.

```sh
pnpm install
pnpm dev
```

Open `http://localhost:5173/mdbase-editor/?demo=5000` for a generated local
collection that does not require authorization.

## Deployment

Pushes to `main` run tests, build the application, and deploy it with GitHub
Pages. The default project URL is
`https://callumalpass.github.io/mdbase-editor/`.

A real full-access grant should use a dedicated origin such as
`https://editor.mdbase.dev/`. GitHub project sites share browser storage across
all repositories under `callumalpass.github.io`, which is too broad a trust
boundary for durable collection credentials.
