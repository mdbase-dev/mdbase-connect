# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who keep notes and other durable records in mdbase-backed Markdown
collections and want a calm, fast writing surface in the browser. They
understand notes, folders, search, and properties, but should not need to
understand relays, tokens, or collection runtimes. Editing is their primary
activity; they enter Connect occasionally to manage storage, applications,
computers, browser sessions, and account access.

## Product Purpose

mdbase editor is a general Markdown collection editor and the web home for
mdbase Connect. Its editing workspace opens one separately authorized
collection, presents every record as a note, and preserves the collection's
files, frontmatter, types, and revision checks. Its `/connect` workspace uses
the user's Connect account session to manage collection inventory, hosted
storage, sign-in methods, application grants, computers, browser sessions, and
account deletion without receiving collection content. It is also the
reference full-access consumer for the mdbase connect SDK.

Success means writing feels local and immediate, durable files remain useful
outside the editor, and consequential access or collection-wide changes remain
deliberate and understandable.

## Positioning

mdbase editor keeps application data as portable, human-readable Markdown files
while adding the structure needed for capable applications. mdbase Connect
makes those collections available to independent applications without turning
account administration into implicit access to collection content. This
separates durable user-controlled data from the software used to work with it.

## Operating Context

The editor is primarily used in a desktop browser for sustained writing and
collection maintenance. A collection may be hosted by mdbase or remain
authoritative on a user's computer through mdbase Connect. The collection rail
switches among Notes, Types, Settings, and the less-frequent Connect management
workspace. Mobile layouts present each navigation level as a separate screen.

Users may also work with the same files through ordinary text editors, Obsidian,
the mdbase SDK, or other authorized applications. Paths and frontmatter are
durable provenance rather than editor-private metadata.

## Capabilities and Constraints

- The editor opens one separately authorized collection and supports notes,
  paths, frontmatter, types, application contracts, search, and revision-aware
  mutations.
- The Connect workspace manages collection inventory, storage, application
  grants, computers, sign-in methods, browser sessions, and the account.
- An account-management session may reveal that a collection exists but never
  grants the editor access to its contents. Each collection requires its own
  exact application grant.
- Collections may be hosted or locally authoritative. The interface must make
  local, hosted, connected, reconnecting, and unavailable states understandable.
- Record creation is delayed until its path, selected type, required fields,
  and initial content are complete.
- Type behavior follows declared collection metadata and schemas; the editor
  must not infer semantics from familiar property names.
- Google access and refresh tokens are not requested or stored for account
  sign-in.

## Brand Commitments

The product name is `mdbase editor`; the connected service is `mdbase connect`.
The voice is quiet, direct, spacious, dependable, and explicit about security
consequences. The shared Frontmatter mark and wordmark assets are canonical.

The product must not resemble a growth-oriented SaaS dashboard, IDE,
knowledge-management cockpit, generic cloud file manager, or imitation native
window. Avoid security theatre, toolbar clutter, and permanent technical
metadata around the document.

## Evidence on Hand

The repository's implementation, unit and browser tests, product documentation,
and assets are the evidence for current behavior and identity. The deployed
editor and Connect service provide integration evidence. No customer
testimonials, usage claims, adoption metrics, or third-party endorsements are
currently established; future work must not fabricate them.

## Product Principles

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

## Accessibility & Inclusion

Target WCAG 2.2 AA for contrast, keyboard navigation, focus visibility, form
labels, and semantic status announcements. Respect reduced motion. Never encode
connection or permission state by color alone, and keep security language in
plain language.
