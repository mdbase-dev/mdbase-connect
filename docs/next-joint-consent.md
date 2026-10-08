# Next application consent

The authenticated pending authorization returns the consenting account's persisted
`account_backend` marker. The portal uses joint controls only for `next`; neither
the existence of a client Noise key nor the selected collection's owner selects
permission semantics.

Next consent pairs the declared record capability with its file actions:

- `collection.read`: list and read files.
- `records.create`: add files.
- `records.edit`: replace, move and rename files.
- `records.delete`: delete files.

Both halves must be explicitly declared by the application. A required record
capability or file action locks the complete pair; optional pairs have one control.
Saved optional approvals restore only when record and file selections are both
complete. Destructive optional pairs start denied. File folder scope stays visible
and unchanged. Collection membership ceilings apply to both halves together.
Unsupported/missing required pairs require an updated application declaration and
fresh approval, never silently enlarged access. Next's offline replica capability
is not supported as an application log grant. Other capability/people/setup
permissions retain their existing semantics; legacy account controls are unchanged.
The server's exact grant-policy check remains the enforcement boundary.
