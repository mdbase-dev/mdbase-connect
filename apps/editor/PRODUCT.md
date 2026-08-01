# Product

## Register

product

## Users

People who keep notes and other durable records in an mdbase collection and
want a calm, fast writing surface in the browser. They understand notes,
folders, search, and properties. They should not need to understand relays,
tokens, or collection runtimes.

## Product purpose

mdbase editor is a general Markdown collection editor and the web home for
mdbase Connect. Its editing workspace opens one separately authorized
collection, presents every record as a note, and preserves the collection's
files, frontmatter, types, and revision checks. Its `/connect` workspace uses
the user's Connect account session to manage collection inventory, hosted
storage, sign-in methods, application grants, computers, browser sessions, and
account deletion without receiving collection content.
It is also the reference full-access consumer for the mdbase connect SDK.

## Brand personality

Quiet, direct, spacious, and dependable. The writing surface should disappear
while someone works, with technical detail available at the edges when it is
useful.

## Anti-references

Avoid a dashboard, IDE, knowledge-management cockpit, file-manager toolbar, or
imitation native window. Avoid cards, dark controls, decorative gradients,
toolbar clutter, and permanent technical metadata around the document.

## Principles

1. Open into the last note and put the cursor near the writing.
2. Save continuously and report conflicts clearly.
3. Treat paths and frontmatter as durable provenance.
4. Keep collection-wide powers explicit during connection and destructive work.
5. Stay responsive with thousands of records and long Markdown documents.
6. Delay creation until a complete path and type-aware initial record are ready.
   Use the type's declared `collection.display` fields for a record's name and
   description; never infer semantics from familiar property names.
7. Keep type definitions inspectable and editable in a dedicated workspace,
   with compatibility risk visible before users save collection-wide changes.
8. Present data contracts as application compatibility: keep field mappings,
   schema-driven behavior settings, and the resulting application view visible,
   with YAML as the precise escape hatch.
9. Keep account management and collection content authorization separate. An
   account may reveal that a collection exists; opening it still requires the
   editor application's exact collection grant.
