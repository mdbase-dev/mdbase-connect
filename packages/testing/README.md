# @mdbase-dev/connect-testing

Supported behavioral fixtures for applications using `@mdbase-dev/connect`.

`installMdbaseBrowserFixture` seeds a production-shaped authorization before
application code runs. Consumer tests declare a manifest, collection, and
authority; this package owns Connect's private browser persistence format. The
returned controller can expire, reduce, reapply, or remove the grant to exercise
recovery without copying token JSON or storage keys into an application.

The fixture grants no production backdoor and is intended only for test builds.
