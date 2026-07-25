# mdbase editor

A quiet, browser-based editor for an entire mdbase collection. It connects to a
user-approved collection through mdbase connect and works with the Markdown
records in place. The Connect authorization screen offers both collections on
your connected computers and collections hosted by mdbase. After approval, the
same editor works against either storage provider.

The editor includes a CodeMirror Markdown surface with optional Vim keys,
`@` and `[[` object-link completion, backlinks, structured and JSON frontmatter
views, deliberate note creation, collection settings, and a dedicated workspace
for inspecting and editing type definitions. Its visual type builder supports
recursive objects, lists of objects, nested lists, required fields, and common
JSON Schema constraints while preserving advanced YAML rules. Type membership
distinguishes explicit declarations from inferred path, field-presence,
structured-predicate, and CEL rules. The same schema drives structured nested
values during note creation and property editing. Use
`@/type/query` to scope the object picker to a declared mdbase type. Type changes
use mdbase connect's explicitly permissioned collection-management operations.

The application requests `describe`, `changes`, `read`, `query`, `validate`,
`create`, `update`, `delete`, `rename`, `read_type`, `create_type`, and
`update_type` for one selected collection. Its manifest explicitly requests
`full_collection` access because these operations span records and collection
type definitions rather than one domain contract.

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

Run the browser suite with `pnpm test:e2e`. It covers hosted authorization and
direct-provider CRUD, the real CodeMirror integration, creation and frontmatter
flows, type inspection, settings, responsive navigation, accessibility, and a
10,000-record performance case.

## Deployment

Pushes to `main` run tests, build the application, and deploy it with GitHub
Pages. The default project URL is
`https://callumalpass.github.io/mdbase-editor/`.

A real full-access grant should use a dedicated origin such as
`https://editor.mdbase.dev/`. GitHub project sites share browser storage across
all repositories under `callumalpass.github.io`, which is too broad a trust
boundary for durable collection credentials.
