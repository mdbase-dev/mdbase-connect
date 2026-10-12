## Added

- Let an app installation end its own device session with only its
  installation credential (`DELETE /v1/next/installation`, used by the SDK's
  `signOut()`). The route revokes the device in each collection it was
  enrolled in, removes its collection access, revokes the credential and its
  background grants, and closes its relay connections. Ordinary connector
  credentials get 403 `installation_required`; an unknown or already revoked
  credential gets 401 `invalid_connector`.
