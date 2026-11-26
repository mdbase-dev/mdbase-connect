## Changed

- The control plane's readiness check now asks the legacy hosted provider for
  a fixed set of contract versions instead of every version the control plane
  supports, so adding a version for the current runtime no longer makes the
  control plane report itself as not ready.
