## Added

- An opt-in `nextClientKey` public-key provider for Next collection consent. The SDK attests the retained Noise client key with the authorization's per-grant signer, without exposing that private signer. The option requires an HTTPS control origin; existing authorization requests are unchanged when it is absent.
