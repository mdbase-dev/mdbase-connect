# Product

## Register

product

## Users

People who keep durable personal or professional data in mdbase-backed Markdown
collections and want to use independent web or native applications without
moving those collections into an application vendor's database. A collection
may be authoritative on their own computer or hosted by mdbase with an optional
local mirror. Users may be comfortable with files and Obsidian, but should not
need to understand relays, OAuth, or networking to control access.

## Product Purpose

mdbase connect makes a user's local and hosted collections safely available to
applications they choose. The local desktop client controls computer-owned
collections; the account portal controls mdbase-hosted collections and shared
application access. The hosted service supplies identity, short-lived
authorization, routing, an outbound-only relay for local authorities, and a
durable authority for hosted collections. Hosted collections are always mdbase
collections—application contracts are optional consumers, never the storage
model. Success means connecting an app feels deliberate and
understandable, while revoking it is immediate and unambiguous.

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
