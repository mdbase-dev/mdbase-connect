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

The production application is configured for
`https://editor.mdbase.dev/` on Cloudflare Pages. The independent
`editor-pages.yml` workflow runs the complete verification and browser suites,
rebuilds the application for its
dedicated origin, then uploads `dist` with Wrangler. Create a Direct Upload
Pages project named `mdbase-editor` with production branch `main`.

Configure the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub
repository secrets, then set the `CLOUDFLARE_PAGES_ENABLED` repository variable
to `1`.

This monorepo is the sole source and publisher for the editor. The retired
standalone `mdbase-dev/mdbase-editor` repository must remain archived and must
never publish to the shared Cloudflare Pages project.

The same workflow publishes a permanent staging build at
`https://editor-staging.mdbase.dev/`. It uses the `staging` Pages branch,
generates a manifest for the staging editor origin, and targets the same-site
`https://connect-staging.mdbase.dev` control-plane origin. The Pages API attaches the
custom domain idempotently; Cloudflare DNS must proxy
`editor-staging.mdbase.dev` to `staging.mdbase-editor.pages.dev`.

LAB is a separate Direct Upload Pages project, `mdbase-editor-lab`, with the
allowlisted `candidate-b` production branch and canonical custom origin
`https://editor-lab.mdbase.dev/`. It targets the same-site
`https://connect-lab.mdbase.dev` Connect origin. These project, branch, and
origins are static and disjoint from staging and production; the deploy command
has no target override. Operations must independently record and validate the
Pages project, `candidate-b` production branch, canonical domain, and managed
Cloudflare account before each qualified release. If Cloudflare configuration
no longer matches this repository contract, an operator must correct and
document that prerequisite before using the command. Do not guess a replacement
branch or attach the LAB domain from this script.

A LAB upload is an explicit exact-commit release, not a working-tree preview.
From a clean checkout whose `origin` identifies
`mdbase-dev/mdbase-connect`, supply the full lowercase commit both as the
expected source and build revision, the exact managed
`CLOUDFLARE_ACCOUNT_ID`, and an absolute report path outside the repository. The
report parent must be operator-owned and not group/world writable, and the
report itself must not already exist:

```sh
commit=$(git rev-parse HEAD)
MDBASE_ENV=lab \
MDBASE_LAB_RELEASE_MODE=exact \
MDBASE_LAB_EXPECTED_COMMIT="$commit" \
VITE_MDBASE_BUILD_REVISION="$commit" \
CLOUDFLARE_ACCOUNT_ID=<exact-managed-account-id> \
MDBASE_LAB_DEPLOYMENT_REPORT=/private/operator/path/editor-lab-deployment.json \
pnpm deploy:dev
```

All source, account, target, and report guards run before package installation,
builds, or Wrangler. The command runs `pnpm install --frozen-lockfile`, uses the
root-pinned Wrangler `4.114.0`, and gives build commands only a minimal
credential-free environment. Cloudflare credentials are exposed only to
Wrangler. Wrangler receives an explicit private empty `--env-file`, so it cannot
auto-load repository `.env` or `.env.local` files. Its human output is
discarded; its pre-created private output file is parsed as NDJSON and must
identify exactly one production deployment bound to the allowlisted project,
branch, expected commit, deployment UUID, and immutable
`<first-8-UUID-chars>.mdbase-editor-lab.pages.dev` origin.

After upload, the command compares deployable files served by both the immutable
deployment origin and canonical LAB origin byte-for-byte with local `dist`.
Cloudflare's supported root routing is explicit: local `index.html` is fetched
at `/`, while other implicit HTML routes are rejected. Pages `_headers` and
`_redirects` control files are validated locally rather than fetched, and
resulting security and cache headers are checked remotely. The manifest
homepage, redirects, Connect origin, and full build revision must all match. In
the report contract, `verification.assertions.build_revision` is the boolean
qualification result; the exact commit remains in `source.commit` and
`verification.revision_evidence.revision`.

A private exclusive sidecar reserves the evidence name while the final report
path remains absent. Before any build, the command also exclusively creates and
fsyncs deterministic sibling evidence `<report>.wrangler.ndjson`, then fsyncs
the secure parent directory. Wrangler appends directly to that mode-`0600` file.
The command fsyncs it before parsing and retains it after every success or
failure so operations can recover the candidate deployment after a crash.
Final reports always contain its filename, digest, and byte count.

Report publication writes and fsyncs a same-directory mode-`0600` temporary
file, hard-links it into the final name without replacement, fsyncs the
directory, removes temporary state, and fsyncs again. A competing final report
or Wrangler evidence file therefore fails closed without being overwritten.
Exceptions finalize a bounded failure report; failures after NDJSON parsing
retain deployment ID and immutable URL, while nonzero or malformed Wrangler
output retains whatever structured evidence was written. The source manifest is
restored in every handled case.

The existing staging rehearsal remains explicit and unchanged:

```sh
pnpm exec wrangler login
MDBASE_ENV=staging pnpm deploy:dev
```

A bare `pnpm deploy:dev` now fails closed instead of publishing an unqualified
LAB working tree. The staging command builds workspace packages, generates the
staging manifest, uploads the allowlisted staging branch, verifies the deployed
manifest and assets, and restores the pre-existing source manifest.
