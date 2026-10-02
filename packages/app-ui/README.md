# `@mdbase-dev/ui`

The shared visual foundation of mdbase apps: Editor, Reader, Writer, and any
app that wants to look like part of the family. Nothing here is required to
build on mdbase Connect.

```ts
import "@mdbase-dev/ui/fonts.css";
import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/brand.css";

import { Wordmark } from "@mdbase-dev/ui/brand";
import { loadThemePreference, applyThemePreference } from "@mdbase-dev/ui/theme";
import { mdbaseAppHref, withAppUrls } from "@mdbase-dev/ui/apps";

applyThemePreference(loadThemePreference());
```

- `tokens.css` defines semantic roles (`--color-canvas`, `--color-text`,
  `--color-text-soft`, `--color-accent`, ...) for light, dark and system
  themes. Style components with roles, not palette values. Short aliases such
  as `--ink` belong to each app.
- `theme` stores the System, Light or Dark choice as `mdbase:theme`.
- `brand` draws the Frontmatter mark, each app's inverted mark, and the
  `mdbase <app>` wordmark. Add `motion.css` to animate the mark: loops
  (`orbit`, `scan`, `bounce`, `stream`, `sort`, `hop`), entrances
  (`keys-first`, `drop`, `assemble`), one-shot `saved`/`error` signals, and a
  `progress` fill.
- `mark-activity` is the page-wide store behind the app switcher's mark.
  `SaveNotice` already reports saves and problems to it. For other work, call
  `signalMdbaseMark("saved" | "error")` when a write the person made finishes,
  `trackMdbaseMarkProgress()` (or `useMdbaseMarkProgress(fraction)`) when the
  total is known, and `holdMdbaseMarkBusy(loop)` (or `useMdbaseMarkBusy`) while
  it is not.
- `apps` lists the mdbase apps and builds links that open the current
  collection in another app. Lab and local builds pass their own URLs to
  `withAppUrls`.

## Shared feedback

Import `@mdbase-dev/ui/feedback` and `@mdbase-dev/ui/feedback.css`, alongside
`tokens.css` and `controls.css`. Place one `FeedbackProvider` above the app shell
(and its error boundary); place `FeedbackButton` in a quiet, accessible shell
location. `useFeedback().open("problem")` opens the same form from an error action.

```tsx
import { FeedbackButton, FeedbackProvider, feedbackApplication,
  resolveFeedbackEndpoint, useFeedback } from "@mdbase-dev/ui/feedback";
import "@mdbase-dev/ui/feedback.css";

<FeedbackProvider
  endpoint={resolveFeedbackEndpoint(configuredFeedbackUrl, development)}
  application={feedbackApplication("mdbase reader", "library", revision, environment)}
  turnstileSiteKey={configuredPublicSiteKey}
  collectionName={optionalCollectionDisplayName}
>
  <YourAppShell><FeedbackButton /></YourAppShell>
</FeedbackProvider>;
```

Products: `mdbase editor`, `mdbase reader`, `mdbase writer`, `mdbase connect`.
Views must be fixed identifiers, never URLs or document paths. Application/build
metadata is always included and previewable; reply email, collection name,
problem diagnostics, and a screenshot are optional. A single, initially collapsed
**What gets sent** disclosure holds app details and optional diagnostic/collection
controls, rather than repeating explanations around the form. Collection-name consent
resets if the name changes. A missing or invalid endpoint hides entry points.

For a **user-visible** failure, call `useFeedback().reportError({ code:
"save_failed" })`. Use the exported `FeedbackErrorCode` union and optional HTTP
status, not raw errors. Cancellation does nothing; background retries should not
call it. The bug wiggles twice, at most once per 30 seconds, and never moves with
reduced motion. It does not install global exception listeners or telemetry.

The form opens focused on its description. Capture starts only on **Attach
screenshot**, closes the native modal before requesting `getDisplayMedia`, then
restores the form/draft and stops every track. Unsupported browsers can choose an
image instead. Draw/highlight/blackout, undo/reset, and keyboard markup export one
flattened raster; blackouts replace whole pixels and are painted last. Uploads
are bounded PNG/JPEG, dimension-checked before decoding and re-encoded to discard
metadata and filenames. Only the explicitly included final image is submitted.
Opening markup excludes the image until Apply; cancelling or failing to apply
redactions leaves the original excluded unless the user explicitly includes it.

Drafts and the 30-event/five-minute diagnostic buffer are in-memory per provider.
Cancel preserves the draft; successful dismissal clears it. No collection/auth
SDK, persistence, public issue tracker, or feedback transport other than the
configured stateless Worker is required. Turnstile loads when the form opens if a
public key is configured. Submission omits credentials and referrers, retains the
request ID for unchanged retries, and resets verification tokens after attempts.

See [shared-feedback.md](../../docs/shared-feedback.md) for the Worker contract,
rollout order, integration status, and regression checks.
