## Fixed

- SDK: a web sign-in cut off while the browser was creating its device keys (a reload, a closed tab, an aborted request) no longer leaves the app permanently blocked with `open_failed`. Until the device has signed its enrolment nothing of it has left the browser, so the next attempt removes the half-created key stores and creates them again. Device key storage that cannot be opened is now the described problem `device_keys_unavailable` instead of a generic open failure.
