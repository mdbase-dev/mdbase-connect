# Connect and editor responsive layout review

## Scope

Browser review using isolated demo data and mocked management responses, not a
production account or LAB daemon. Chromium screenshots covered 320, 834, and
1440px in light and dark themes:

- Connect collection overview, storage, application-access empty state,
  computers, and collection list.
- Editor note writing, note creation, type definition, and settings.

The existing browser suites additionally exercised populated application access,
expanded permissions, account forms, mobile navigation, search, properties,
source editing, dialogs, and keyboard accessibility. This is not a complete
visual audit of every hosted-sharing or remote-authority state.

## Findings addressed

| Finding | Change |
| --- | --- |
| Application permissions collided with app identity on narrow screens. | Stack identity, permissions, and Review; wrap long names and origins. |
| Mobile header overflowed at 320px. | Reduce surplus space around Back to editor. |
| Section actions sat below their headings. | Preserve centered heading/action alignment on mobile. |
| Mobile overview had excessive section gaps. | Reduce section spacing from 52px to 32px. |
| Connection repeated its status in the same row. | Show one labeled status beside the explanation. |
| Standalone row links became centered beneath a partial column. | Place them on a full-width grid row, aligned to the content edge. |
| Type field-name inputs overlapped the type selector. | Explicitly identify them as text inputs so the existing control sizing and theme styles apply. |
| Long note titles were clipped by a single-line input. | Use a wrapping, content-sized textarea. Keep titles semantically single-line; cap the title area and allow scrolling for exceptionally long titles. |
| Tablet writing space was unnecessarily narrow. | Size gutters from the editor pane rather than the viewport; retain the 760px maximum reading measure and manual sidebar controls. |

## Evidence

- 51 registered Connect, editor, and theme Playwright tests passed.
- 54 exploratory screenshot/overflow checks passed across the nine surfaces,
  three viewport widths, and two themes listed above.
- 452 editor unit tests and the manifest-script test passed.
- `pnpm test:accessibility` passed for portal, editor Connect, and desktop.
- Builds include editor TypeScript checks.

Permanent regression coverage lives in `apps/editor/tests/connect.spec.ts` and
`apps/editor/tests/editor.spec.ts`. It checks responsive action alignment,
spacing, status duplication, long identities, type-field bounds, title wrapping,
very long title containment, title edits across note navigation, and alignment
between the title and body writing measure.

## Remaining verification

Check on physical mobile Safari and Android browsers for virtual-keyboard,
notch/safe-area, text-selection, and IME behavior. Browser automation here used
Chromium with resized viewports; it does not establish those device behaviors.
No broader navigation redesign or automatic sidebar collapse was introduced.
