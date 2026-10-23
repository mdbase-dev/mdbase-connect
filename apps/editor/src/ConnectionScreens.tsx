import { displayLocale } from "./i18n/format";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
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
  useLingui();
  const updatingAccess = missingCapabilities.length > 0;
  return <ConnectLayout
    app="editor"
    title={<><Trans>Your notes,</Trans><br /><Trans>as files.</Trans></>}
    lead={updatingAccess
      ? t`Update access to ${accessSummary(missingCapabilities)} in this collection.`
      : t`Choose the collection you want to write in.`}
    error={notice}
  >
    {!fatal && !hideSavedConnections && connections.length > 0 && <div className="saved-collections" aria-label={t`Recent collections`}>
      <p><Trans>Recent collections</Trans></p>
      {connections.map((connection) => {
        const name = connection.displayName ?? t`Untitled collection`;
        return <div className="saved-collection-item" key={connection.collectionId}>
          <button className="saved-collection-row" onClick={() => onOpen(connection.collectionId)}>
            <span><strong>{name}</strong><small><Trans>Previously opened in mdbase editor</Trans></small></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <ActionMenu label={t`Collection options for ${name}`} items={[{
            label: t`Forget from this browser`,
            icon: <Trash2 aria-hidden="true" />,
            tone: "danger",
            onSelect: () => onForget(connection)
          }]} />
        </div>;
      })}
    </div>}
    {!fatal && <button className="mdbase-connect-action mdbase-button is-primary" onClick={onConnect}>{actionLabel ?? (updatingAccess
      ? t`Update access`
      : connections.length
        ? t`Connect another collection`
        : t`Choose a collection`)} <ChevronRight aria-hidden="true" /></button>}
    {!fatal && <p className="mdbase-connect-footnote">{updatingAccess
      ? t`mdbase keeps the access you already approved and shows only what needs to be added.`
      : t`You’ll continue to mdbase. Sign in if asked, choose a collection, and approve mdbase editor. You’ll return here automatically; your files stay where they are.`}</p>}
    <FeedbackButton />
    <details className="compatibility-help"><summary><Trans>Collection not listed?</Trans></summary><p><Trans>The editor opens mdbase 0.3 collections. For an older collection, use mdbase to upgrade a copy, verify that copy, then choose it here. Your original files can stay untouched while you check the result.</Trans></p></details>
  </ConnectLayout>;
}

function accessSummary(capabilities: string[]): string {
  const labels: Record<string, string> = {
    "collection.inspect": t`inspect the collection`,
    "records.watch": t`sync changes`,
    "records.read": t`open notes`,
    "records.query": t`list and search notes`,
    "records.validate": t`check notes`,
    "records.update": t`edit notes`,
    "records.rename": t`move notes`,
    "files.list": t`list files`,
    "files.read": t`open files`,
    "files.add": t`add files`,
    "definitions.read": t`manage type definitions`,
    "definitions.create": t`manage type definitions`,
    "definitions.update": t`manage type definitions`,
    "collection.read": t`open and search notes`,
    "records.create": t`create notes`,
    "records.edit": t`edit and move notes`,
    "records.delete": t`delete notes`,
    "definitions.manage": t`manage type definitions`
  };
  const missing = [...new Set(capabilities.map((capability) => labels[capability] ?? capability.replaceAll(".", " ")))];
  if (missing.length < 2) return missing[0] ?? t`use the editor`;
  return new Intl.ListFormat(displayLocale(), { style: "long", type: "conjunction" }).format(missing);
}
