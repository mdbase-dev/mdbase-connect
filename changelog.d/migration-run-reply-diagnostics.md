## Fixed

- Preserve bounded HTTP and transport-error classes from the initial migration Worker run reply before status reconciliation, so an absent run no longer hides the request's diagnostic evidence. Never emit response text, exception messages or credentials.
