# Shared private feedback

`@mdbase-dev/ui/feedback` owns the single form, error-responsive bug icon,
Turnstile verification, screenshot capture, and raster markup. The stateless
`services/feedback` Worker remains the only email-delivery implementation.

## Integration status and boundaries

Editor uses a provider above its workspace/error boundary, with a shell footer
button and an entry on the connection screen. Connect uses the same components
in its footer/mobile navigation and opening/failure screens. The old Connect
form, screenshot parser, diagnostic buffer, and local Turnstile implementation
have been replaced, not retained alongside the shared implementation. Feedback
styles load with the lazy workspace modules, keeping the existing initial bundle
budgets unchanged.

Existing `/connect/feedback` bookmarks open the shared form via a small route
shim. Retain that shim until those URLs are deliberately retired; new buttons
open the form without navigating or replacing the working page.

Reader and Writer are supported by the shared application/schema contracts but
are **not wired into their separate repositories in this change**. They still
pin an older published UI package. Their integration needs a coordinated UI
package release and consumer dependency updates; do not commit local absolute
worktree links or pretend an already-published version includes these exports.

The initial error hooks cover Editor save/source-open failures, Connect explicit
management mutations and initial opening failures, and rendered fatal errors.
They send only bounded codes/statuses to a per-provider buffer. Periodic Connect
refreshes, visibility-triggered refreshes, cancellations, and normal validation
are not bug-animation triggers. There is no global exception listener or new
logging/telemetry pipeline. Future user-visible failures should use the same
`useFeedback().reportError` API rather than introduce another reporter.

The form leads with topic choices and the description: no eyebrow slogan,
app/view caption, or duplicate screenshot heading. A single, initially collapsed
**What gets sent** disclosure contains app/build previews and optional collection
and diagnostic controls. The screenshot privacy reminder appears only when an
image is attached; capture/markup statuses and the success message stay brief.

## Payload and privacy

The endpoint remains `POST /v1/feedback`; `schema_version: 2` distinguishes the
shared payload from existing deployed clients' schema v1. V1 remains accepted
until a separate compatibility decision confirms that older deployments no
longer need it.

- Required: UUID request ID, one of `problem | idea | appreciation`, a description
  of at most 5,000 characters, and bounded application information.
- Application: one of the four fixed product names, a fixed view identifier,
  validated revision or `null`, and production/staging/development/lab.
- Optional: reply email, explicitly consented collection display name, problem
  diagnostics, and one included screenshot.
- Diagnostics: coarse browser/OS/viewport and up to 30 bounded error events from
  the previous five minutes. No record content, paths, origins, raw errors,
  stack traces, request data, cookies, or tokens are collected.
- Image: PNG/JPEG, at most 3 MiB, no original filename. Uploaded dimensions are
  checked before decoding (16 MP/8,192 pixels per edge), then rasterized to strip
  metadata. Screen capture is resized to at most 1,600 × 1,200.
- Markup is flattened. Opaque, integer-aligned blackout rectangles render last;
  the original image/layers are never included in the submitted payload.
  Opening markup temporarily excludes the image. Apply includes the final raster;
  Cancel leaves the original excluded until the user explicitly opts it back in,
  so failed/discarded redactions cannot silently send the original screenshot.

Capture closes the native dialog **before** requesting display media, makes app
content inert, waits for a fresh frame, stops all tracks, and restores the draft
and dialog. Cancellation/error/unmount paths also stop returned tracks, including
streams delivered after unmount. The form remains usable without a screenshot.

The browser omits credentials and referrers; draft/screenshot/events stay only
in memory. Failed submission retains the draft and request ID for unchanged
retries; changing included content creates a new ID. The Worker uses existing
Resend idempotency, strict origin validation, Turnstile hostname/action checks,
plain-text private email, and existing image/body limits. No public issue or new
feedback store is created. The public artifact remains a separate no-upload demo.

## Rollout order (no deployment performed here)

1. Through `mdbase-cloud-ops`' guarded release process, deploy the Worker with v1
   and v2 support **before** deploying a v2 browser client.
2. Keep exact `ALLOWED_ORIGINS`; add the approved Reader/Writer origins through
   ops rather than broadening CORS. Configure the Turnstile site for those hosts
   before enabling protected forms there.
3. Publish the shared UI through the repository's normal version/release flow.
   This feature branch does not independently bump versions or publish packages.
4. Deploy Editor/Connect with `VITE_MDBASE_FEEDBACK_URL` and the existing
   `VITE_MDBASE_TURNSTILE_SITE_KEY`. Then update Reader/Writer's UI pins, providers,
   shell entry points, and meaningful-failure hooks against that released package.
5. Verify private delivery and client compatibility with approved test data;
   never use production collection content for screenshot acceptance tests.

For Reader/Writer, import `tokens.css`, `controls.css`, and `feedback.css`, wrap
one app shell/error boundary in `FeedbackProvider`, and render `FeedbackButton`
outside settings. Set application identity with `feedbackApplication`, never
from the current URL/document name. Native browsers without `getDisplayMedia`
use the optional image chooser rather than attempting DOM reconstruction.
Shared dialogs stop bubbling keydown events so page-level shortcuts do not act
behind the form. Apps with global **capture-phase** shortcuts must additionally
ignore events whose target is within a native `dialog[open]`; those listeners run
before a dialog can stop bubbling.

## Regression checks

Use the repository's Node 24 environment and build Editor's workspace dependencies
first. All mail requests in browser/unit tests are intercepted; no inbox is used.

```sh
pnpm --filter 'mdbase-editor^...' build
pnpm --filter @mdbase-dev/ui test
pnpm --filter @mdbase/feedback-worker typecheck
pnpm --filter @mdbase/feedback-worker test
pnpm --filter mdbase-editor typecheck
pnpm --filter mdbase-editor exec vitest run
pnpm --filter mdbase-editor exec playwright test tests/feedback.spec.ts
pnpm check:architecture
pnpm --filter mdbase-editor check:bundle
pnpm --filter mdbase-editor check:csp
```

`feedback.spec.ts` covers light/dark/mobile axe checks, description focus,
consent-only submission, modal closure before permission, cancellation/draft
restoration, keyboard blackout pixels, final-only attachment, and reduced motion.
Unit tests also cover late stream cleanup after unmount, idempotent retry IDs,
verification token reset, diagnostic bounds, four products, three subjects,
malformed/private metadata, and legacy Worker submissions.

For **real Chromium self-tab capture**, build the e2e demo and start a local
preview at port 8877, then run sequentially from `apps/editor`:

```sh
pnpm build:e2e
pnpm exec vite preview --host 127.0.0.1 --port 8877 --strictPort
# In another terminal (Linux with Xvfb):
xvfb-run -a -s '-screen 0 1800x1400x24' node tests/feedback-capture.mjs
CAPTURE_POSITIVE_CONTROL=1 xvfb-run -a -s '-screen 0 1800x1400x24' node tests/feedback-capture.mjs
```

The positive control deliberately disables native-dialog closing and must find
magenta canary pixels in the capture; the ordinary run must find zero. Both check
stopped tracks, draft restoration, and zero feedback requests. This driver is
explicit/manual, not included in ordinary headless tests. Interactive chooser
behavior on Firefox/Safari and native distributions still requires platform
acceptance checks.

### Feature-branch verification

Under Node 24.19.0: 37 shared-UI tests, 40 Worker tests, 529 Editor tests, and
seven Chromium browser checks passed. UI/Editor/Worker typechecks, production/e2e
builds, unchanged bundle limits, CSP, architecture, and whitespace checks passed.
Real 1,400 × 1,000 self-tab capture found zero form pixels; disabling modal
closure produced 39,600 canary pixels. All returned tracks ended and neither run
made a feedback request. Browser screenshot submission also passes through the
real Worker validator with only the mail provider mocked.

No package publication, production deployment, real inbox delivery, LAB run, or
full Rust/server CI qualification was performed. Those remain release/platform
checks rather than evidence implied by the local UI and stateless Worker tests.
