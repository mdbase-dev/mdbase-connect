# SDK: application access and step-up

`createMdbase` replaces the Connect session's `authorize(target)`:
`signIn()` (sign in or choose), `reauthorize()` (the open or requested
collection, `authorize("selected")`), `approve(id)` (`{collectionId}`) and
`chooseAnother()`. Call them from the user gesture; the SDK reserves the popup,
and a `signal` replaces `timeoutMs`. There is no per-call capability list
(`requestCapabilities`, `requestOperations`, `ensure*`): approval always asks for
the declaration's groups.

`effectiveCapabilities(declaration, connection)` compares the declaration's v2
required and optional groups with the current session's negotiated hello grant,
for step-up UI only, and returns `{values, requiredAvailable, missing}` (null
without a v2 contract). It does not refresh permissions or authorize an
operation; native operation checks remain authoritative. For write access after
a read-only grant, show `missing` and call `reauthorize()`. Reauthorization still
requires user approval and may return another restricted grant.

## Optional file actions at the moment of use

Declare a file action the app needs only sometimes (adding an image, say) in
`requirements.files.optional`, and ask for it the first time the person does
that, from the same click:

```ts
const result = await app.requestAccess({files: ["add"]}, {reason: "Insert images into your notes"});
if (result.status === "granted") await connection.files.upload(path, image);
else if (result.status === "declined") show(describeError("access_declined"));
// "cancelled": the window was closed, the request expired or `signal` aborted.
```

`requestAccess` resolves `granted` at once, with no window, when the action is
already allowed (required, or allowed earlier). Otherwise it opens Connect for
the open collection with the one-line `reason` (at most 140 characters). The
connection stays open and the app keeps its state. An action the manifest does
not declare rejects with `access_undeclared`. Until the person allows it,
`files.upload` (and `replace`, `move`, `delete` when optional) rejects with a
`forbidden` error whose reason is `access_required`; its `describeError` copy
has an "Allow" action that should call `requestAccess`. `files.grant` leaves out
writes not yet allowed.

File-action consent is advisory on an installation device: Connect records the
person's choice and the SDK enforces it, but the app's own replica is not
narrowed by it.
