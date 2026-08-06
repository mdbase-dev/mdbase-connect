# mdbase editor

A quiet, browser-based editor for an entire mdbase collection, with an
editor-native Connect workspace at `/connect`. It connects to a user-approved
collection through mdbase connect and works with the Markdown
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

The editor lives at `apps/editor` in the mdbase Connect monorepo. It consumes
the Connect SDK, protocol, UI, and management client through `workspace:*`
dependencies, so one lockfile describes the complete build.

The runtime boundaries, state ownership rules, and concurrency invariants are
documented in [ARCHITECTURE.md](./ARCHITECTURE.md).

```sh
pnpm install
pnpm build:packages
pnpm --filter mdbase-editor dev
```

Open `http://127.0.0.1:5173/?demo=5000` for a generated local
collection that does not require authorization.

Open `http://127.0.0.1:5173/connect` for account management. The Connect server
must set `MDBASE_CONNECT_MANAGEMENT_ORIGINS=http://127.0.0.1:5173` so its
HttpOnly account cookie can be used from the editor origin. Production and
staging should keep the editor and Connect on the same registrable domain and
allowlist only their exact editor origin.

Run the browser suite with `pnpm test:e2e`. It covers hosted authorization and
direct-provider CRUD, the real CodeMirror integration, creation and frontmatter
flows, type inspection, settings, responsive navigation, accessibility, and a
10,000-record performance case.

## Deployment

The canonical editor lives in the independent
[`mdbase-dev/mdbase-editor`](https://github.com/mdbase-dev/mdbase-editor)
repository. That repository alone publishes the production and staging
Cloudflare Pages branches. The editor workflow here remains a compatibility CI
check for Connect changes and must not deploy to the shared `mdbase-editor`
Pages project; doing so would replace the canonical application with this
embedded compatibility copy.
