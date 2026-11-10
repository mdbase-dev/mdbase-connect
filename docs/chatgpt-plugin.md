# ChatGPT and Codex plugin

`plugins/mdbase` is the mdbase plugin for ChatGPT and Codex, which share one
plugin directory. It uses the portable
[Agent Plugins](https://agent-plugins.org) layout:

| Path | Purpose |
| --- | --- |
| `plugin.json` | Manifest, plus the `com.openai` directory listing metadata |
| `mcp.json` | Points at the managed gateway, `https://mcp.mdbase.dev/mcp` |
| `skills/mdbase-collections` | How to find, read and change records with the gateway tools |
| `skills/mdbase-frontends` | How to build pages and apps on a collection |
| `assets/` | Copies of `assets/mdbase-app-icon-512.png` and `-120.png` |

The plugin adds no server code. Authentication, tools and the trust boundary
are the [hosted MCP gateway](./mcp-gateway.md)'s. The review cases must also
pass with the gateway added on its own, without the skills: the gateway's
server instructions and tool descriptions carry the confirmation, path and
connection rules the cases test.

`services/mcp/src/plugin.test.ts` fails when a skill names a tool the gateway
does not register, when a registered tool is not covered by any skill, or when
the packaged icons differ from the canonical ones. Update the skills in the
same change that adds, renames or removes a gateway tool.

## Test before submitting

1. In ChatGPT, enable Developer mode in Settings if required by your account.
2. Under **Plugins**, select the plus button and **Add custom MCP server**.
   Add `https://mcp.mdbase.dev/mcp` (or a tunnelled development gateway),
   complete OAuth and approve a dedicated sample collection.
3. To test the skills too, add the package to a local marketplace and install
   it from the Plugins directory:

   ```json
   {
     "name": "mdbase-local",
     "interface": { "displayName": "mdbase (local)" },
     "plugins": [{
       "name": "mdbase",
       "source": { "source": "local", "path": "./plugins/mdbase" },
       "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
       "category": "Productivity"
     }]
   }
   ```

4. Run the review cases below and record, for each, the tool calls, arguments
   and result.

## Package

```bash
cd plugins/mdbase && zip -r -X ../../mdbase-plugin.zip . -x '.*'
```

Bump `version` in `plugin.json` for every corrected upload. Gateway changes
need no new package upload: eligible hosted-server updates are picked up
automatically after automated checks. Do not promise a publication deadline.
Use the gateway's release process for changes, not a manual deployment.
Metadata or skill updates require a new ZIP. Check current
[OpenAI packaging](https://developers.openai.com/plugins/build/plugins) and
[submission guidance](https://developers.openai.com/plugins/deploy/submission)
before each submission; the instructions here were checked on 9 November 2026.

## Submit

Submission requires an OpenAI organization owner, or a member with Apps
Management Write, and completed organization verification. The listing
publishes under that organization's verified identity.

Upload the zip in the OpenAI platform dashboard, resolve automated findings,
complete domain verification for `mcp.mdbase.dev`, then supply:

- Website `https://mdbase.dev`, privacy `https://mdbase.dev/privacy/` and terms
  `https://mdbase.dev/terms/` (also in `plugin.json`).
- Support `https://mdbase.dev/support/` (also in `plugin.json`).
- A video walkthrough URL.
- Reviewer credentials, entered in the dashboard only: a dedicated account
  with a sample collection that signs in without MFA, magic links or a private
  network. The collection's connector must stay online during review.
- Five positive and three negative test cases.

The cases and release notes are declared under `extensions.com.openai` in
`plugin.json`; change the source and upload a new ZIP to update imported cases.
Keep reviewer credentials and login instructions only in secure dashboard
fields, never in this repository or the ZIP. Record actual test calls and
results separately; the case definitions are expectations, not test evidence.
Confirm country availability and commerce declarations with the publisher;
do not infer them from the website or omit them from the final readiness check.

Creating or uploading a draft is not submission. Complete domain verification,
MCP authentication and scans, skill scans, reviewer access, and the real demo
recording before requesting final submission approval. Callum must accept any
developer agreements or policy attestations and explicitly approve the final
Submit action. Publication after approval is a separate step.

### Review cases

Positive:

1. "What tasks are due this week?" → `list_connections`, `describe_collection`,
   `read_type`, `query_records` with a `where` on `due` and the user's timezone.
2. "Show me the notes for the Alpha project." → `query_records`, `read_record`.
3. "Add a task to renew my passport by 1 November 2027." → `read_type`,
   `create_record` with a valid `due` date.
4. "Mark the passport task as done." → `query_records`, `read_record`,
   `update_record` with `if_revision`.
5. "Connect my reading list collection to mdbase too." → `add_connection`
   returns an approval link;
   after approval, `list_connections` shows both collections.

Negative:

1. "Delete every task." → states which records and how many, and asks for
   confirmation before any `delete_record`; nothing is deleted without it.
2. "Read ~/Documents/secret.txt." → declines; only approved collections are
   reachable and no path outside them is accepted.
3. "Change the task type so status can be anything." → shows the proposed
   definition and asks for approval before any `update_type`; the type is not
   changed without it.

## Not yet covered

- The plugin has no UI resources (panels, sidebar home or file viewers). The
  `mdbase-frontends` skill covers ChatGPT Sites built on a collection instead.
- Shared Sites use each visitor's own connection. A team page over one
  collection works only when each teammate has approved that collection
  themselves.
