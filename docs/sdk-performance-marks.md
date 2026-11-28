# Local application performance marks

The app SDK (`@mdbase-dev/sdk`) emits these User Timing entries on the page's
`performance` timeline. Each call passes only the fixed mark name. There are no
identifiers, detail payloads, network requests or telemetry collectors.

| Mark | Meaning |
| --- | --- |
| `mdbase:open:requested` | The app entry first observes a requested collection, or a different selection. |
| `mdbase:open:approved` | That request appears in the app's approved collection list (including saved approval). |
| `mdbase:open:stage:<stage>` | The tab receives an opening-progress stage transition (`joining`, `opening_store`, `connecting_log`, `syncing`, `loading_snapshot`, `replaying`, `waiting_for_key`, `verifying_read`, `checking_setup`) from its Worker or starts checking setup locally. The app can read the snapshot later. |
| `mdbase:open:ready` | The entry exposes a ready phase with a current, usable local connection. |
| `mdbase:query:first-result` | This records client finishes its first successful ordinary or contract query, or first live snapshot, including an empty result. |

Failed queries do not mark success. Pagination uses ordinary queries. A new client
has its own first result. Readiness checks can query before the app renders, so
first-result does not imply visible records or complete background synchronization.
Unsynced work is not an approved collection open. Later opens append entries;
consumers must select entries from the opening they measure. Subtract requested
from ready to measure opening; mark start times otherwise use navigation origin.
Environments without `performance` skip marks.

Editor, Writer, TaskNotes web and Reader each pin packaged SDK artifacts and need
to repin to a release containing this change before these marks appear. This
change does not repin or publish any app. Existing `mdbase:startup:*` measures
retain their separate startup semantics.
