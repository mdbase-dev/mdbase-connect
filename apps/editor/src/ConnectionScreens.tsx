import {
  CaretRightIcon as ChevronRight,
  FilePlusIcon as FilePlus2,
  TrashIcon as Trash2,
  XIcon as X
} from "./icons";
import { ActionMenu } from "./ActionMenu";
import { Wordmark } from "./Brand";
import { Dialog } from "./Dialog";
import type { ConnectionSummary } from "./model";

export function ConnectScreen({ notice, missingCapabilities = [], connections, onConnect, onOpen, onForget, actionLabel, hideSavedConnections = false, fatal = false }: {
  notice?: string;
  missingCapabilities?: string[];
  connections: ConnectionSummary[];
  onConnect: () => void;
  onOpen: (collectionId: string) => void;
  onForget: (connection: ConnectionSummary) => void;
  actionLabel?: string;
  hideSavedConnections?: boolean;
  fatal?: boolean;
}) {
  const updatingAccess = missingCapabilities.length > 0;
  return <main className="connect-screen"><section>
    <Wordmark />
    <h1>Your notes,<br />as files.</h1>
    <p className="connect-copy">{updatingAccess
      ? `Update access to ${accessSummary(missingCapabilities)} in this collection.`
      : "Choose the collection you want to write in."}</p>
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
    {!fatal && <button className="connect-button" onClick={onConnect}>{actionLabel ?? (updatingAccess
      ? "Update access"
      : connections.length
        ? "Connect another collection"
        : "Choose a collection")} <ChevronRight aria-hidden="true" /></button>}
    {!fatal && <p className="access-copy">{updatingAccess
      ? "mdbase connect keeps the access you already approved and shows only what needs to be added."
      : "You’ll continue to mdbase connect. Sign in if asked, choose a collection, and approve mdbase editor. You’ll return here automatically; your files stay where they are."}</p>}
    <details className="compatibility-help"><summary>Collection not listed?</summary><p>The editor opens mdbase 0.3 collections. For an older collection, use mdbase to upgrade a copy, verify that copy, then choose it here. Your original files can stay untouched while you check the result.</p></details>
    {notice && <p className="connect-error" role="alert">{notice}</p>}
  </section></main>;
}
export function CollectionSwitcher({ activeCollectionId, connections, displayName, onOpen, onConnect, onClose }: {
  activeCollectionId?: string;
  connections: ConnectionSummary[];
  displayName: string;
  onOpen: (collectionId: string) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  return <Dialog titleId="collection-switcher-title" className="collection-switcher" onClose={onClose}>
    <header>
      <h2 id="collection-switcher-title">Choose a collection</h2>
      <button className="icon-button" aria-label="Close collection switcher" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="collection-switcher-list">
      {connections.map((connection) => {
        const active = connection.collectionId === activeCollectionId;
        const name = active ? displayName : connection.displayName ?? "Untitled collection";
        return <button
          key={connection.collectionId}
          className={active ? "current" : undefined}
          aria-current={active ? "true" : undefined}
          onClick={() => active ? onClose() : onOpen(connection.collectionId)}
        >
          <span><strong>{name}</strong>{active && <small>Current collection</small>}</span>
        </button>;
      })}
    </div>
    <footer>
      <button className="collection-connect-another" onClick={onConnect}><FilePlus2 aria-hidden="true" />Connect another collection</button>
    </footer>
  </Dialog>;
}


function accessSummary(capabilities: string[]): string {
  const labels: Record<string, string> = {
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
