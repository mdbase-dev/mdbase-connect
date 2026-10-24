## Fixed

- Send `Access-Control-Allow-Credentials` only for the account and management origins, the only origins allowed to use the account session cookie. Other origins, including first-party, native and third-party SDK apps that authenticate with bearer tokens, keep origin reflection without credentials.
