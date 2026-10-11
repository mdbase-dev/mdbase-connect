# Installation approval controls

Synthetic first-run TaskNotes request for an account with no collections, "New collection…" chosen and Advanced open. No real account or device data. Captured with an isolated headless browser against a local production portal build.

| Viewport | Before | After |
| --- | --- | --- |
| 390px light | ![Before, 390px light](before-390-light.png) | ![After, 390px light](after-390-light.png) |
| 390px dark | ![Before, 390px dark](before-390-dark.png) | ![After, 390px dark](after-390-dark.png) |
| Desktop light | ![Before, desktop light](before-desktop-light.png) | ![After, desktop light](after-desktop-light.png) |
| Desktop dark | ![Before, desktop dark](before-desktop-dark.png) | ![After, desktop dark](after-desktop-dark.png) |

The consent checkboxes now use the shared `Checkbox` and `CheckboxGroup` from `@mdbase-dev/ui/checkbox`. The additional-access group no longer draws the browser's fieldset outline, and the reminders checkbox keeps its 18px size with the 44px target on its label. When there is nothing extra to allow, the Advanced section is not shown.
