## Fixed

- One malformed `.base` record no longer stops an app from listing any saved
  views. With `listAppBasesViews({..., reportUnreadable: true})`, a replica that
  grants `bases-discovery-unreadable-v1` skips each record it cannot classify and
  names it in the page's new `unreadable` list (path, record, revision, reason and
  detail). Older replicas, and requests without the flag, refuse the discovery
  as before. Code that builds `AppBasesDiscoveryResult` success values by hand
  must now add `unreadable: []`.
