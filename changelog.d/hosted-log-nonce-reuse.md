## Changed

- Hosted sync now signs each log call with the fresh nonce the log service
  returned on the previous response, as the app SDK already does. A steady
  stream of calls takes one request to the log Worker each instead of two
  (`GET /v1/nonce` plus the call). The first call after an actor restarts
  still fetches a nonce, as does any call to a log service that does not
  return one. A nonce the log refuses gets one retry with a freshly fetched
  one; nothing else is retried.
