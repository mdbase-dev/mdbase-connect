## Fixed

- Sign-in and sync now trust what the operating system trusts. On Windows, Connect verifies servers through the Windows certificate chain engine, so root certificates in the Local Computer store, Group Policy and enterprise roots (such as an HTTPS-inspection CA) work as they do in browsers. A certificate failure now names its cause instead of only "error sending request".
