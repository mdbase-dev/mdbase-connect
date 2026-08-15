# Unified mdbase CLI

## Decision

The ecosystem ships one native command named `mdbase`.

```text
mdbase <data-command>
mdbase connect <control-command>
mdbase profile <workload>
```

The command is one distribution surface, not one implementation crate. Its
internal packages retain strict dependency direction:

```text
mdbase engine
      ▲
      │
mdbase-command ───────────────┐
                              │
Connect protocol/core/daemon ─┼──▶ mdbase CLI executable
                              │
Connect profiling ────────────┘
```

The final executable is a leaf. The mdbase engine never imports Connect.
Connect continues to depend on public mdbase APIs and remains the local
authorization, routing, replication, and service-lifecycle boundary.

## Command ownership

Top-level data commands operate on records, types, views, validation,
migrations, and collection-local maintenance. They are defined by the
`mdbase-command` crate beside the Rust engine so their request construction and
direct execution cannot drift from collection semantics.

The `mdbase connect` namespace owns accounts, computer pairing, registered
authorities, hosted collections, mirrors, application grants, activity, and the
per-user daemon. These commands remain clients of the versioned local control
protocol. They do not open the Connect registry or its databases directly.

The `mdbase profile` namespace owns repeatable performance workloads:

- `engine` runs the deterministic synthetic engine workload and may enforce
  checked-in p95 budgets;
- `connect` runs a read-only workload through the local authority registry;
- ordinary daemon requests retain opt-in payload-free phase timings.

Profiling reports never contain collection paths, operation inputs, record
frontmatter, or bodies.

## Data targets

Data commands accept exactly one target:

- `--root PATH` opens a collection directly, defaulting to the current
  directory;
- `--collection UUID` sends the canonical operation through the user's local
  Connect daemon. The daemon executes against a computer-owned authority when
  one is registered, or directly against a hosted authority when this CLI has
  an approved per-collection connection. A filesystem mirror is not required.

Target selection is explicit. The CLI does not silently change authority
because a path happens to be registered. Direct access remains available for
offline operation and recovery.

Account login grants collection administration but not record access. Before
the first direct hosted operation, authorize the CLI as its own application:

```text
mdbase connect hosted authorize <collection-id>
mdbase --collection <collection-id> query --types task
```

The first command uses device authorization and browser approval. `--read-only`
requests only non-mutating operations; `--operations` requests an explicit
comma-separated subset. Grant credentials and the proof key are kept in the
operating-system credential store. `hosted connections` lists these grants and
`hosted disconnect` revokes one without deleting the collection.

Commands that are inherently filesystem-local, such as collection
initialization or cache repair, reject `--collection` with a stable
`unsupported_target` diagnostic. Portable record, type, view, query, and
validation operations use the same operation name and JSON input for both
targets.

## Process and installation model

The daemon foreground entry point is:

```text
mdbase connect daemon run
```

Service installation copies the invoking unified executable into the private
Connect runtime directory and registers that stable path. Service identifiers,
state directories, local protocol names, deep-link schemes, and product names
remain `mdbase-connect`; they identify the Connect subsystem rather than the
CLI filename.

The desktop application embeds the same `mdbase` executable. Desktop updates
continue to treat the application and embedded daemon runtime as one signed,
transactional release.

## Output and errors

Canonical data operations preserve the portable
`{ valid, result, diagnostics }` envelope. Connect administration retains calm
human output by default and stable JSON under `--json`. Diagnostics go to
stderr, secret values are never rendered, and stable error codes determine
non-zero exit status.

`--timings` writes one additional JSON line to stderr after the command:

```json
{"profile":{"command":"query","target":"direct","total_us":1234,"success":true}}
```

The command and target values come from fixed enums. The observation never
contains a filesystem path, collection ID, query, input, result, diagnostic
message, or record value.

A later presentation layer may add human record tables without changing the
portable JSON contract. Output formatting does not belong in the engine.

## TypeScript CLI retirement

The TypeScript CLI stops being an independent implementation. Before it is
archived, every command is classified as:

1. already represented by a canonical Rust operation;
2. a thin presentation/import/export adapter to retain in `mdbase-command`;
3. a specialized optional tool that should not occupy the core CLI.

The former npm package is private and has no library or binary entry points. Its
source remains readable only as capability-migration history. If a native
package-manager installer is added later, it may download and verify the native
executable but must not contain a second collection engine or command
implementation. TypeScript SDK packages are unaffected.

## Verification contract

The unified command is qualified with:

- parser and output golden tests;
- direct-versus-daemon operation parity fixtures;
- daemon unavailable and protocol-version failures;
- concurrent direct and daemon writers with revision protection;
- service installation and restart tests on every supported platform;
- packaged Electron smoke tests using the embedded unified executable;
- deterministic engine and Connect profile runs with checked budgets;
- release builds proving that no legacy `mdb` or `mdbase-connect` executable is
  required.
