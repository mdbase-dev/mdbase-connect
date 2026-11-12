# SDK: one session across an app's contexts

Tabs of one app already share a session: one sign-in and one Worker holding the
keys and the open collections. The SDK finds the other tabs by its own module
URL, so this only covers contexts that load the same bundled file.

A browser extension is built as several bundles: pages, an offscreen document
and a service worker. Each has its own copy of the SDK, so each would run its
own Worker. The `session` option puts them in one session.

```ts
// offscreen document: runs the Worker
const mdbase = createMdbase(declaration, { session: { build: BUILD } });
await mdbase.start();
mdbase.setForeground(false);

// popup, side panel, options page
const mdbase = createMdbase(declaration, { session: { build: BUILD, host: false }, followVisibility: true });

// service worker
const mdbase = createMdbase(declaration, {
  session: { build: BUILD, host: false },
  signIn: { open: url => chrome.tabs.create({ url }) },
});
```

Every context gets the whole API: `subscribe`, `getSnapshot`, the collection client,
sign-in and sign-out. There is no proxy to write.

## `build`

A name for this build of the app, such as its version plus a commit. Contexts
of one origin that pass the same `build` share a session. Contexts with
different names never do, so an old page left open after an update keeps to its
own Worker, as tabs on different builds do today.

All contexts under one `build` must pass the same declaration.

`build` is 1 to 128 characters with no control characters.

## `host`

`host: false` means this context never runs the Worker. It joins the context
that does, and waits in `starting` while there is none. Use it in a service
worker, which cannot construct a Worker, and in any context that should not
keep the session alive on its own, such as a popup.

Left out, a context may run the Worker, like a tab. If several such contexts
exist, one runs it and the rest join, and another takes over when it closes.

The `worker` option has no effect with `host: false`, and passing both throws.

## What the app does

- **Keep a hosting context alive.** A context with `host: false` waits until
  some context runs the Worker. In an extension, create the offscreen document
  before the first call and again if it is closed.
- **Call `start()` in the hosting context.** It answers other contexts only
  once it has started.
- **Select a collection in each context.** Selection belongs to the context.
  A service worker has no URL to select from, so it calls `select(id)`.
- **Pass `signIn.open` where there is no `window`.** A service worker cannot
  open a popup.
- **Report foreground from the contexts people see.** The session is in the
  foreground while any context says it is. A context is in the foreground
  until it says otherwise, so the offscreen document calls
  `setForeground(false)` and pages pass `followVisibility: true`.

## After a sign-out

Signing out stops the Worker in every context. The hosting context stays idle
until something starts it. When a `host: false` context calls `start()` and no
context runs the Worker, an idle hosting context starts again by itself, so a
service worker can begin sign-in without messaging the offscreen document.

## Limits

- Same origin only. The contexts find each other with Web Locks and a
  `BroadcastChannel`, which do not cross origins. A page on another origin,
  such as an Obsidian plugin talking to a loopback page, is not covered.
- A context that cannot host still needs the rest of the SDK's browser
  features, including OPFS and IndexedDB.
