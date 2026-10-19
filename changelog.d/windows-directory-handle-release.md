## Fixed

- Release collection directory handles after runtime shutdown by updating the
  canonical filesystem engine's derived-cache ownership. Windows cleanup no
  longer waits on a stale global identity handle.
