## Fixed

- SDK: a sign-in that was already sent is no longer dropped when the app restarts before it is approved (a reload, or a mobile WebView frozen in the background and resumed). The restarted session keeps reading the same request until it is approved, cancelled or expires; a request that was never sent still shows as signed out.
