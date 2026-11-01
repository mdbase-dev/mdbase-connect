## Fixed

- Desktop update checks verify signed releases again. Electron's BoringSSL has no default digest for ECDSA keys, so Sigstore's TUF root and transparency-log checks rejected every release with "root was signed by 0/3 keys" (#426).
