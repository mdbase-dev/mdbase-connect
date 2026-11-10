## Fixed

- `mdbase sync mode` now waits for the on-screen confirmation and the switch itself instead of giving up after 30 seconds; a lost reply reports the outcome as unknown and points to `mdbase sync mode-status`. Approving an app and turning approval off from the CLI also wait for their confirmation.
- `mdbase sync mode` refuses with `mode_switch_unavailable` before asking for confirmation when the server cannot run the switch yet.
- `mdbase sync mode --resume` fails with `mode_nothing_to_resume` when this computer has no switch to resume, instead of reporting `waiting_for_device` forever.
- `mdbase sync mode-status` reports the server's `current_mode` instead of replacing it with this computer's registered mode.
