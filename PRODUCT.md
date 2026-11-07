# Product

## Register

product

## Users

People who keep durable personal or professional data in mdbase-backed Markdown
collections and want to use independent web or native applications without
moving those collections into an application vendor's database. Users may be
comfortable with files and Obsidian, but should not need to understand relays,
OAuth, or networking to control access.

## Collection Model

Every collection is the same kind of thing: an mdbase collection whose changes
are written to a log. A collection can live in folders on any number of the
user's computers, and syncing it moves its log to mdbase. There is no separate
"hosted" or "local" kind of collection to choose between.

- **Cloud copy** is the default when sync is on. mdbase keeps a readable copy,
  so web apps and agents can use the collection while every computer is off.
  A collection created in the portal starts this way.
- **Private** is an advanced choice. The log is end-to-end encrypted, so mdbase
  cannot read it, and thin clients reach the collection only while one of the
  user's devices running the desktop app is online. It is never the default.
- **Sync off** keeps the log on one computer. It is a state of a collection,
  not another kind of collection.

What syncs is controlled in two places. The collection's inclusion settings
decide which files belong to it at all (file types, excluded folders, a size
limit), for every device and the cloud copy alike. They are set in the desktop
app; the portal does not change them. Separately, each desktop computer will
decide which included files it keeps on disk; the runtime does not support that
yet. There is no separate filter for the cloud copy: a file the cloud copy does
not have is not in the collection.

## Product Purpose

mdbase connect makes a user's collections safely available to applications
they choose. The Connect portal is the primary web surface for
collections, application access, computers, browser sessions, and the account
at `/account`. The Editor links to this portal and remains an independently
authorized collection application. The desktop client remains the authority
for adding folders, turning sync on, Private encryption, and which files its
computer keeps on disk.
The portal also handles sign-in, account recovery, pairing, and grant approval. The hosted service supplies identity, short-lived
authorization, routing, an outbound-only relay for local authorities, and a
durable authority for hosted collections. Hosted collections are always mdbase
collections—application contracts are optional consumers, never the storage
model. Success means connecting an app feels deliberate and understandable.
Revoking access disables Connect-issued credentials immediately; hosted access
is shown as `Revoking` until the data authority confirms the same boundary,
then as `Revoked`. An account-management session
may list and administer collections, but it never grants the editor access to
their contents; each collection still receives its own application grant. The
collection is the minimum data-authorization boundary: an authorized
application may access every record in that collection, limited by its explicit
action and file capabilities. Portable contracts describe compatibility, setup, and semantic application
behavior, not a subset of records hidden behind the grant. Offline caches and
filesystem mirrors are replicas of an authorized collection; an application may
present a contract-shaped semantic projection without changing that authority.
Consent therefore says “Entire collection” separately from contract setup.

For a local-authority collection, the browser SDK should use the connector's
same-computer loopback service when the user has allowed local-network access,
then fall back to the encrypted relay when direct access is unavailable. This
is an automatic route choice, not another storage mode or onboarding decision.

## Brand Personality

Quiet, trustworthy, capable. The product should feel like a well-made operating
system utility: technically serious, calm under failure, and explicit about what
is local, what is connected, and what an application can do.

## Anti-references

Do not resemble a growth-oriented SaaS dashboard, developer console, app store,
crypto wallet, or generic cloud file manager. Avoid security theatre, excessive
status decoration, nested cards, vague permission language, and workflows that
send users to a browser for routine local administration.

## Design Principles

1. Put the consequential choice where the data lives.
2. Describe permissions as concrete actions on a named collection.
3. Make local, cloud, online, paused, and offline states visibly distinct.
4. Prefer immediate reversible controls over configuration ceremonies.
5. Keep expert detail available without making it the default reading level.

## Accessibility & Inclusion

Target WCAG 2.2 AA for contrast, keyboard navigation, focus visibility, form
labels, and semantic status announcements. Respect reduced motion. Never encode
connection or permission state by color alone, and keep security copy in plain
language.
