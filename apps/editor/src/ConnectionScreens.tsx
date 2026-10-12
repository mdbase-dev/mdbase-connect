import {
  CaretRightIcon as ChevronRight,
  TrashIcon as Trash2
} from "./icons";
import { ActionMenu } from "./ActionMenu";
import { ConnectLayout } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import "@mdbase-dev/ui/feedback.css";
import type { ConnectionSummary } from "./model";
interface ConnectScreenProps {
  notice?: string;
  missingCapabilities?: string[];
  connections: ConnectionSummary[];
  onConnect: () => void;
  onOpen: (collectionId: string) => void;
  onForget: (connection: ConnectionSummary) => void;
  actionLabel?: string;
  hideSavedConnections?: boolean;
  fatal?: boolean;
}

export function ConnectScreen({ notice, missingCapabilities = [], connections, onConnect, onOpen, onForget, actionLabel, hideSavedConnections = false, fatal = false }: ConnectScreenProps) {
  const updatingAccess = missingCapabilities.length > 0;
  return <ConnectLayout
    app="editor"
    title={<>Your notes,<br />as files.</>}
    lead={updatingAccess
      ? `Update access to ${accessSummary(missingCapabilities)} in this collection.`
      : "Choose the collection you want to write in."}
    error={notice}
  >
    {!fatal && !hideSavedConnections && connections.length > 0 && <div className="saved-collections" aria-label="Recent collections">
      <p>Recent collections</p>
      {connections.map((connection) => {
        const name = connection.displayName ?? "Untitled collection";
        return <div className="saved-collection-item" key={connection.collectionId}>
          <button className="saved-collection-row" onClick={() => onOpen(connection.collectionId)}>
            <span><strong>{name}</strong><small>Previously opened in mdbase editor</small></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <ActionMenu label={`Collection options for ${name}`} items={[{
            label: "Forget from this browser",
            icon: <Trash2 aria-hidden="true" />,
            tone: "danger",
            onSelect: () => onForget(connection)
          }]} />
        </div>;
      })}
    </div>}
    {!fatal && <button className="mdbase-connect-action mdbase-button is-primary" onClick={onConnect}>{actionLabel ?? (updatingAccess
      ? "Update access"
      : connections.length
        ? "Connect another collection"
        : "Choose a collection")} <ChevronRight aria-hidden="true" /></button>}
    {!fatal && <p className="mdbase-connect-footnote">{updatingAccess
      ? "mdbase keeps the access you already approved and shows only what needs to be added."
      : "You’ll continue to mdbase. Sign in if asked, choose a collection, and approve mdbase editor. You’ll return here automatically; your files stay where they are."}</p>}
    <FeedbackButton />
    <details className="compatibility-help"><summary>Collection not listed?</summary><p>The editor opens mdbase 0.3 collections. For an older collection, use mdbase to upgrade a copy, verify that copy, then choose it here. Your original files can stay untouched while you check the result.</p></details>
  </ConnectLayout>;
}

function accessSummary(capabilities: string[]): string {
  const labels: Record<string, string> = {
    "collection.inspect": "inspect the collection",
    "records.watch": "sync changes",
    "records.read": "open notes",
    "records.query": "list and search notes",
    "records.validate": "check notes",
    "records.update": "edit notes",
    "records.rename": "move notes",
    "files.list": "list files",
    "files.read": "open files",
    "files.add": "add files",
    "definitions.read": "manage type definitions",
    "definitions.create": "manage type definitions",
    "definitions.update": "manage type definitions",
    "collection.read": "open and search notes",
    "records.create": "create notes",
    "records.edit": "edit and move notes",
    "records.delete": "delete notes",
    "definitions.manage": "manage type definitions"
  };
  const missing = [...new Set(capabilities.map((capability) => labels[capability] ?? capability.replaceAll(".", " ")))];
  if (missing.length < 2) return missing[0] ?? "use the editor";
  if (missing.length === 2) return `${missing[0]} and ${missing[1]}`;
  return `${missing.slice(0, -1).join(", ")}, and ${missing.at(-1)}`;
}
