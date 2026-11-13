## Fixed

- SDK: closing the Connect window, reloading the page or losing the connection just after choosing a Private collection no longer leaves the app refusing to start with "Reload required" until sign-out. The unfinished choice is forgotten, the app stays signed in with the collections it already had and shows that no collection was added, and the collection can be added again. An installation already stuck this way starts normally after updating; no sign-out is needed.
