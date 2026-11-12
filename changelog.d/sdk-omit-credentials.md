## Security

- SDK: the app-grant client and the control-route resolver now send their control-plane requests with `credentials: "omit"`, like every other SDK request. In a browser extension with host permissions for the Connect origin, a default fetch carried the person's Connect cookies; the SDK authorizes by signature and bearer token only. An extension no longer needs to replace `globalThis.fetch` for the SDK's requests.
