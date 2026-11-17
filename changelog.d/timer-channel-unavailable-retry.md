## Fixed

- Turning reminders on no longer demands fresh notification approval after
  Connect answers the channel registration with a 503 problem (for example
  `push_target_sealing_required`, `web_push_unavailable` or `busy`). Connect
  rolls those back, so the SDK now reports `unavailable` and keeps the timer
  grant usable: trying again sends a new registration. Answers whose outcome is
  still unknown (a network failure, a timeout, a 500 or a non-JSON gateway
  error) keep requiring approval, as before. Timer errors now read "Timer
  request could not complete." instead of naming native timers on the web.
