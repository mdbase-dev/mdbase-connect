# Claude plugin

`plugins/mdbase` is also the mdbase plugin for Claude (chat, Cowork and Claude
Code). It shares its skills and icons with the
[ChatGPT and Codex package](./chatgpt-plugin.md) and adds three files Claude
reads:

| Path | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | Claude manifest, plus the directory listing icon and URLs |
| `.mcp.json` | Points at the managed gateway with Claude's `http` transport name |
| `README.md` | Shown as the listing description in Anthropic's directory |

`services/mcp/src/plugin.test.ts` fails when the two manifests disagree on
name, version, author or license, or when the two connector files name
different gateway URLs. Bump `version` in both manifests together. Each
manifest's `description` names its own host, and the README names Claude, so
the ChatGPT package command leaves the README out.

The plugin adds no server code. Authentication, tools and the trust boundary
are the [hosted MCP gateway](./mcp-gateway.md)'s.

## Test before submitting

1. Run `claude plugin validate ./plugins/mdbase`.
2. In Claude Code, run `claude --plugin-dir ./plugins/mdbase`. `/mcp` shows the
   gateway's connection state; sign in and approve a dedicated sample
   collection. The skills appear as `/mdbase:mdbase-collections` and
   `/mdbase:mdbase-frontends`.
3. For claude.ai and Cowork, zip the folder with its dotfiles
   (`cd plugins && zip -r ../mdbase-claude-plugin.zip mdbase`) and upload it
   under **Customize > Plugins > Add > Upload plugin**. Connect the gateway
   from the plugin's **Connectors** tab.
4. Call every gateway tool at least once from a conversation. The connector
   submission asks you to confirm this.

## Submit

Anthropic's directory takes two submissions, both from the developer portal
at `https://claude.ai/directory/manage`: the gateway as an **MCP connector**,
then this folder as a **Plugin bundle**. Submit both from the same Claude
organization so the listings can be paired. The first organization to submit
a repository holds that listing.

The directory cannot download this repository: its archive is far over the
50 MiB validation limit. It follows the `claude-plugin` branch instead, whose
tree is exactly `plugins/mdbase` on `main`. The **Claude plugin branch**
workflow (`.github/workflows/claude-plugin-branch.yml`) adds a commit to that
branch whenever a push to `main` changes `plugins/mdbase`. Never commit to the
branch by hand.

Submitting needs a paid Claude plan; on Team and Enterprise, an Owner. The
plugin submission also needs a GitHub account connected to that Claude
organization with push access to this repository.

**MCP connector.** Enter `https://mcp.mdbase.dev/mcp`. Tools and their
annotations sync from the live gateway. The listing takes a name, one-liner,
description, categories, icon and a permanent URL slug. Use the manifest's
`description` as the one-liner and the README's opening paragraph as the
description. It also asks for:

- Documentation `https://mdbase.dev/apps/mcp/`, privacy
  `https://mdbase.dev/privacy/`, support `https://mdbase.dev/support/`.
- Authentication: OAuth, required. The gateway supports dynamic client
  registration, so no client ID or secret is entered.
- Data handling: the API is our own; the connector reads and writes.
- Confirmation that every tool has been run, and seven policy
  acknowledgements.

Never put reviewer credentials in the portal. If the listing is escalated to
Verified review, a reviewer asks for test access by email: give them a
dedicated account with a sample collection.

**Plugin bundle.** Enter repository `mdbase-dev/mdbase-connect`, leave the
plugin path empty and enter branch `claude-plugin`, then select **Validate**
and fix any blocking finding.
Listing details are read from `.claude-plugin/plugin.json` and `README.md`;
change them in the repository, not the portal. Answer the data handling
questions from the README's Data section, then complete the four
acknowledgements.

Callum must accept the directory terms and policy acknowledgements and
explicitly approve each final Submit action.

## After listing

The directory tracks `claude-plugin`, so every merged change under
`plugins/mdbase` reaches it through the workflow and is scanned as a new
version, and by default a reviewer publishes it after
**Publish** is selected in the portal. A version that fails the security scan
holds later versions too, so run `claude plugin validate` before merging a
change to this folder.

Gateway changes need no plugin release; the connector listing reads the live
server.

Check Anthropic's current
[plugin](https://claude.com/docs/plugins/submit) and
[connector](https://claude.com/docs/connectors/building/submission) submission
guidance before each submission; the instructions here were checked on
14 November 2026.
