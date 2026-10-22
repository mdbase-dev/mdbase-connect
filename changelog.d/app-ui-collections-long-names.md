## Fixed

- `@mdbase-dev/ui/collections`: long collection names wrap in switcher rows even
  when the host app styles `button > span` to one ellipsized line, and the
  switcher trigger shows up to two lines of the name before cutting it short. The
  full name stays in the trigger's accessible name and title.
