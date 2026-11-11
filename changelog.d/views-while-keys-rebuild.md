## Fixed

- Saved views can be read while a reopened app replica re-derives its keys from the log. They were refused with `view_read_not_ready` until the first sync turn, so an app that was offline at start listed records but showed no view.
