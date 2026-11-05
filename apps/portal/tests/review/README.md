# Portal review

Run `pnpm portal:review`, then open `http://127.0.0.1:4801/__review`.
It builds the real portal and its dependencies. Use `pnpm portal:review --no-build`
to reuse `apps/portal/dist`. `PORT=4802 pnpm portal:review` changes the port.
The review build enables local feedback; an ordinary production build may not.

Scenario links reset an isolated, cookie-selected in-memory account. Reloads and
navigation preserve mutations until another scenario is selected or the server
restarts. Add `?latency=300` to a scenario link for slower APIs (default 60ms).
Sign-in accepts any password; Google/GitHub stay local. No real credentials,
mail, hosting, or collection contents are involved. Signup verification is
available directly through `signup-agreements`; no email is delivered.

Run `pnpm test:portal-review` for all scenarios at both viewport sizes and themes,
mutation walks, and isolated interaction budgets. Browser dates are fixed;
timers still run. Unknown API routes fail rather than silently succeeding.
Screenshot comparisons are opt-in: `MDBASE_VISUAL_GOLDENS=1 pnpm test:portal-review`.
No golden images are included. After UI polish, use Playwright's `--update-snapshots`
to accept the intended baselines explicitly.

`provider-unavailable` uses the existing sharing-provider error surface.
Pending onboarding stays pending; failed onboarding can
be retried successfully. These fixtures do not claim to implement sync or custody.

The fake UI configuration and onboarding handoff point to
`http://127.0.0.1:4802/?demo=300`. Start the Editor there with
`pnpm --filter mdbase-editor build:e2e` then
`pnpm --filter mdbase-editor preview --port 4802 --strictPort`, or set
`REVIEW_EDITOR_URL` to your own local Editor URL. Onboarding hands off to this full demo URL, not a real collection grant.
Collection Open links use its origin with the normal server/collection parameters;
they do not pretend a demo record is a hosted collection. Use an unused `PORT` for this review server too.

Before either server, run `pnpm install --frozen-lockfile`, then build
`@mdbase-dev/i18n`, `@mdbase-dev/connect-protocol`, `@mdbase-dev/connect`, and
`@mdbase-dev/ui`. The Editor intentionally uses its exact published UI pin;
reviewing portal workspace UI does not silently substitute it in the Editor.
