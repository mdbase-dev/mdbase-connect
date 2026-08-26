# Editor browser tests

`collaboration-browser.spec.ts` is a browser-adapter smoke test for two real
CodeMirror editors and separate Yjs replicas in Chromium. Its transport is a
controllable in-page test harness only. It explicitly does **not** cover
provider authorization, persistence, or WebSockets/hosted transport.
