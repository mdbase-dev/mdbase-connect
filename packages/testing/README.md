# @mdbase-dev/connect-testing

Supported behavioral fixtures for applications using `@mdbase-dev/connect`.

`installMdbaseBrowserFixture` atomically seeds a production-shaped authorization
on the currently loaded application origin. Consumer tests declare a manifest,
collection, and authority; this package owns Connect's private browser
persistence format. The returned controller can expire, reduce, reapply, or
remove the grant to exercise recovery without copying token JSON or storage keys
into an application.

Connector fixtures create the same non-exportable agreement/signing keys and
encrypted-grant metadata used by the browser SDK. Hosted fixtures create the
authority proof key as well. Navigate to the application origin, install the
fixture, then reload. The installation promise does not resolve until the keys
and token are both durable, so startup cannot race a partially written grant.
Connector fixtures also expose `fixture.relay`, which decrypts route-level test
requests and encrypts matching success responses with the production relay
profile. Consumer tests never need to know or reproduce grant cryptography.

The fixture grants no production backdoor and is intended only for test builds.
