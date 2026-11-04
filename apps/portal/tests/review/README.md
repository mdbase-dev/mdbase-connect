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

`sync-conflict` and `provider-unavailable` use the existing sharing-provider error
surface; the current portal has no separate replica-conflict UI.
Pending onboarding stays pending; failed onboarding can
be retried successfully. These fixtures do not claim to implement sync or custody.
