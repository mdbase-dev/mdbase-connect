## Added

- Add optional `@mdbase-dev/connect/timers` `appTimers(connection)`, a
  retained-app-grant port for the existing opaque control-plane timer HTTP API
  and specific WebPush/FCM channel operations. It does not open a data session,
  expose credentials or retry uncertain writes. `close()` stops this port
  without deleting persistent notifications. Private collection timer
  permissions still require control-plane approval/resolver support; no hosted
  or old data-API fallback is introduced.
