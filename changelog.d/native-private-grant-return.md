## Added

- `MdbaseSignInOpener.grantReturnUrl`: a native shell whose approval runs in the system browser can name a declared same-origin redirect for Private collection grants, so the grant result can be handed back to the app (which passes it to `deliverAppGrantCallback`). Before, the grant always returned to the first redirect on the app's origin, which a Capacitor app's Custom Tab or SFSafariViewController opened in the browser instead of the app, so Private collections could not be connected from Android or iOS.
