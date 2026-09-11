# Repository guidance

## Avoid additive complexity

Rapid AI-assisted development can amplify ordinary engineering failure modes:
locally safe additions accumulate faster than old mechanisms are removed;
uncertainty becomes optional state, defensive branches, fallbacks, and
compatibility; conformance work produces parallel adapters instead of one
canonical implementation; and inexpensive code generation weakens the natural
pressure to simplify.

Target these mechanisms regardless of who wrote the code. Do not assume that
defensive code, compatibility, abstraction, or product breadth is inherently
wrong; evaluate each against concrete invariants, consumers, persisted
representations, tests, and ownership boundaries.

Before handing off a change, ask:

- What existing mechanism does this replace and delete?
- What evidence proves each new state or fallback is reachable?
- Is expected invalid input distinguished from an internal invariant failure?
- Does compatibility name its consumer and removal condition?
- Does each new abstraction represent a real boundary or repeated concept?
- Does the change expand public, persisted, configured, or user-facing state?
- Has the change produced net simplification?

Prefer strong invariants over defensive hedging, replacement over accumulation,
explicit failure over silent recovery, and simplification over expansion.

- Read `PRODUCT.md` for product intent and `DESIGN.md` for interface direction
  before changing user-facing flows.

- Keep mdbase collection semantics in `mdbase-rs`; do not duplicate them here.
- During v0.3 development, the Rust workspace intentionally uses `../mdbase-rs`
  as a path dependency.
- Treat the local connector as the final authorization boundary. Every remote
  filesystem operation must be checked against its locally cached exact grant.
- Never send local collection paths to the control plane or persist record
  payloads there.
- Keep Rust and TypeScript protocol changes versioned and compatible.
- Run `cargo fmt --all`, `cargo test --workspace`, `pnpm typecheck`, `pnpm test`,
  and `pnpm e2e` before handing off changes that affect the request path.
- Use `pnpm test:fast`, `pnpm test:integration`, and the narrowest registered
  `pnpm test:system -- --suite ...` selection for test-infrastructure changes;
  use `pnpm test:all` only when every local system boundary is required.
- `MDBASE_CONNECT_DEV_AUTH=1` is for local development only.
