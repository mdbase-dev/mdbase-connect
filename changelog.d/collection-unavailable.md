## Fixed

- An application whose grant is still valid now receives HTTP 409
  `collection_unavailable` with `details.reason` (`paused` or
  `claimed_by_newer_runtime`) when its local collection is unavailable,
  instead of a misleading 401 "Access token is invalid or expired." The
  server stores the reason reported by connectors (migration
  `0037_collection_unavailable_reason`), and the Connect portal shows
  "Moved to newer runtime" instead of "Paused" for a collection a newer
  mdbase runtime has claimed.
