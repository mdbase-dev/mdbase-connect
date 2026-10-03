## Fixed

- Authentication accessibility checks now enforce the shared typography tokens,
  heading hierarchy, filled primary action, and email/provider divider without
  requiring the previous uniform type treatment. Development sign-in preserves
  its system-test accessible names; successful auth configuration clears obsolete
  session-lookup errors without hiding authentication return errors.
