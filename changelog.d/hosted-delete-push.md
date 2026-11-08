## Changed

- Deleting a collection or an account, or switching a collection from Cloud copy
  to Private, now wakes the collection's hosted and escrow copies through the
  existing activation request, so they erase their stored copy within seconds
  instead of at their next idle poll (up to 10 minutes). The copy still confirms
  the deletion with Connect before it erases anything. Undelivered wakes are
  retried with the activation backoff, and the idle poll remains the fallback.
