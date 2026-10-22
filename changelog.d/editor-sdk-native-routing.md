## Security

- The Editor now uses SDK-owned, account-bound Native approvals, collection routing and client lifetime instead of an app-owned historical-grant section. Unbound approvals left by older browser sessions are not listed or opened; approve those collections again through Add a collection. Existing browser grants are not imported or relabeled. The pinned SDK attempts whole-store grant cleanup on sign-out; another account's surviving grants remain hidden even if cleanup fails. Isolated custom-adapter lifecycle tests do not add a production fallback.
