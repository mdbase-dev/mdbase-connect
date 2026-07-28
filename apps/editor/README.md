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

The production application is configured for
`https://editor.mdbase.dev/` on Cloudflare Pages. GitHub Actions runs the
complete verification and browser suites, rebuilds the application for its
dedicated origin, then uploads `dist` with Wrangler. Create a Direct Upload
Pages project named `mdbase-editor` with production branch `main`.

Configure the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub
repository secrets, then set the `CLOUDFLARE_PAGES_ENABLED` repository variable
to `1`.

The same workflow publishes a permanent staging build at
`https://editor-staging.mdbase.dev/`. It uses the `staging` Pages branch,
generates a manifest for the staging editor origin, and targets
`https://mdbase-connect-staging.onrender.com`. The Pages API attaches the
custom domain idempotently; Cloudflare DNS must proxy
`editor-staging.mdbase.dev` to `staging.mdbase-editor.pages.dev`.
