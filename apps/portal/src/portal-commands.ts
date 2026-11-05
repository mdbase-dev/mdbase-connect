import { navigationShortcuts, useConnectKeyboard } from "@mdbase/connect-ui/keyboard";
import { createElement, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { type Command } from "@mdbase-dev/ui/command-palette";
import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
import { type AccountSession, type HostedCollection, type NativeCollection, type ManagementOverview } from "@mdbase/connect-management";
import { type applicationGroups } from "./ApplicationAccess";
import { relativeTime } from "./ConnectPrimitives";
import { countLabel } from "./count-label";
import { CloudIcon, DesktopIcon, SquaresFourIcon } from "@phosphor-icons/react";

export type ConnectView = "overview" | "storage" | "access" | "collections" | "applications" | "computers" | "account" | "feedback";

type CommandCollection = { id: string; name: string; detail: string } & ({ kind: "hosted"; source: HostedCollection } | { kind: "native"; source: NativeCollection } | { kind: "local" });

export function usePortalCommands({ data, collections, applications, sessions, selectedCollectionId, navigate, viewLabel, enabled, openEditor, reviewRequest }: {
  data: ManagementOverview | undefined;
  collections: readonly CommandCollection[];
  applications: ReturnType<typeof applicationGroups>;
  sessions: readonly AccountSession[] | undefined;
  selectedCollectionId: string | undefined;
  navigate(view: ConnectView, collectionId?: string): void;
  viewLabel(view: ConnectView): string;
  enabled: boolean;
  openEditor: (() => void) | undefined;
  reviewRequest: (() => void) | undefined;
}) {
  const pending = useRef<MutationObserver | null>(null);
  const cancel = () => { pending.current?.disconnect(); pending.current = null; };
  const activate = (navigate: () => void, selectors: readonly string[], click = false) => {
    cancel();
    flushSync(navigate);
    let next = 0;
    const advance = () => {
      const clearFilter = document.querySelector<HTMLButtonElement>(".connect-main .connect-list-filter button:not([hidden])");
      if (clearFilter) flushSync(() => clearFilter.click());
      while (next < selectors.length) {
        const element = document.querySelector<HTMLElement>(selectors[next]);
        if (!element) return;
        next++;
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: "nearest" });
        if ((click || next < selectors.length) && !(element.matches("summary") && element.parentElement?.hasAttribute("open"))) flushSync(() => element.click());
      }
      cancel();
    };
    pending.current = new MutationObserver(advance);
    pending.current.observe(document.querySelector(".connect-main")!, { childList: true, subtree: true });
    advance();
  };
  const commands: Command[] = [];
  const target = (id: string) => `[data-command=${JSON.stringify(id)}]`;
  const reveal = (view: ConnectView, selectors: readonly string[], click = false) => activate(() => navigate(view, selectedCollectionId), selectors, click);
  const groupLabels: Record<string, string> = { collections: viewLabel("collections"), apps: viewLabel("applications"), computers: viewLabel("computers"), sessions: t(i18n)`Browser sessions`, navigation: t(i18n)`Navigation`, commands: t(i18n)`Actions` };
  commands.push(
    ...(["overview", "storage", "access"] as const).flatMap(view => collections.map(collection => ({ id: view === "overview" ? `collection:${collection.id}` : `${view}:${collection.id}`, label: view === "overview" ? collection.name : `${collection.name} · ${viewLabel(view)}`, detail: collection.detail, icon: createElement(collection.kind === "hosted" || collection.kind === "native" && collection.source.sync === "cloud_copy" ? CloudIcon : DesktopIcon), group: "collections", run: () => navigate(view, collection.id) }))),
    ...applications.map(application => ({ id: `app:${application.applicationId}`, label: application.applicationName, detail: countLabel(application.collectionCount, "collection"), keywords: [...application.grants.map(grant => grant.collection_name), ...application.installations.map(entry => entry.collection_name)].filter(Boolean).join(" "), icon: createElement(SquaresFourIcon), group: "apps", run: () => reveal("applications", [`${target(`app:${application.applicationId}`)} > summary`], true) })),
    ...(data?.connectors ?? []).map(computer => ({ id: `computer:${computer.id}`, label: computer.name, detail: countLabel(data!.collections.filter(collection => collection.connector_id === computer.id).length, "collection"), icon: createElement(DesktopIcon), group: "computers", run: () => reveal("computers", [target(`computer:${computer.id}`)]) })),
    ...(sessions ?? []).map(session => ({ id: `session:${session.id}`, label: session.client_name, detail: session.current ? t(i18n)`This browser, active now` : t(i18n)`Last used ${relativeTime(session.last_seen_at)}`, group: "sessions", run: () => reveal("account", [target(`session:${session.id}`)]) })),
    ...(["collections", "applications", "computers", "account", ...(selectedCollectionId ? ["overview", "storage", "access"] as const : [])] as const).map(view => ({ id: view, label: t(i18n)`Go to ${viewLabel(view)}`, shortcut: navigationShortcuts[view], group: "navigation", run: () => navigate(view, selectedCollectionId) })),
    { id: "create", label: t(i18n)`Add collection`, shortcut: "c", group: "commands", run: () => reveal("collections", [target("create")], true) },
    ...collections.flatMap(collection => {
      if (collection.kind !== "hosted") return [];
      const row = target(`collection:${collection.id}`);
      return [
        ...(collection.source.authority_state === "active" && collection.source.access.can_rename_collection ? [{ id: `rename:${collection.id}`, label: t(i18n)`Rename ${collection.name}`, detail: collection.detail, group: "commands", run: () => reveal("collections", [`${row} .connect-collection-menu > button`, `${row} [role=menuitem][data-action=rename]`], true) }] : []),
        ...(collection.source.authority_state === "active" ? [{ id: `sync:${collection.id}`, label: t(i18n)`Sync folder · ${collection.name}`, detail: collection.detail, group: "commands", run: () => reveal("collections", [`${row} .connect-collection-menu > button`, `${row} [role=menuitem][href]`], true) }] : []),
        ...(collection.source.access.can_delete_collection ? [{ id: `delete:${collection.id}`, label: t(i18n)`Delete ${collection.name}`, detail: collection.detail, group: "commands", run: () => reveal("collections", [`${row} .connect-collection-menu > button`, `${row} [role=menuitem][data-action=delete]`], true) }] : [])
      ];
    }),
    ...applications.map(application => ({ id: `revoke-app:${application.applicationId}`, label: t(i18n)`Revoke ${application.applicationName}`, group: "commands", run: () => reveal("applications", [`${target(`app:${application.applicationId}`)} > summary`, `${target(`app:${application.applicationId}`)} .connect-revoke-application`], true) })),
    ...(data?.connectors ?? []).flatMap(computer => [
      { id: `rename-computer:${computer.id}`, label: t(i18n)`Rename ${computer.name}`, group: "commands", run: () => reveal("computers", [`${target(`computer:${computer.id}`)} .connect-collection-menu > button`, `${target(`computer:${computer.id}`)} [data-action=rename]`], true) },
      { id: `revoke-computer:${computer.id}`, label: t(i18n)`Revoke ${computer.name}`, group: "commands", run: () => reveal("computers", [`${target(`computer:${computer.id}`)} .connect-collection-menu > button`, `${target(`computer:${computer.id}`)} [data-action=revoke]`], true) }
    ]),
    ...(sessions ?? []).filter(session => !session.current).map(session => ({ id: `revoke-session:${session.id}`, label: t(i18n)`Sign out ${session.client_name}`, group: "commands", run: () => reveal("account", [`${target(`session:${session.id}`)} button`], true) })),
    ...((sessions ?? []).some(session => !session.current) ? [{ id: "sign-out-others", label: t(i18n)`Sign out other sessions`, group: "commands", run: () => reveal("account", [`${target("sign-out-others")} button`], true) }] : []),
    ...(["system", "light", "dark"] as const).map(value => ({ id: `theme:${value}`, label: value === "system" ? t(i18n)({ message: "System", context: "Color theme" }) : value === "light" ? t(i18n)({ message: "Light", context: "Color theme" }) : t(i18n)({ message: "Dark", context: "Color theme" }), detail: t(i18n)`Theme`, group: "commands", run: () => reveal("account", [".connect-preferences > button.theme-select", `[role=option][data-value=${value}]`], true) })),
    { id: "language", label: t(i18n)`Language`, group: "commands", run: () => reveal("account", [".connect-preferences .language-setting button, .connect-preferences .language-setting select"], true) },
    { id: "feedback", label: viewLabel("feedback"), group: "commands", run: () => navigate("feedback", selectedCollectionId) },
    { id: "shortcuts", label: t(i18n)`Keyboard shortcuts`, shortcut: "?", group: "commands", run: () => keyboard.showHelp() },
    ...(data?.authentication.provider !== "tailscale" ? [{ id: "sign-out", label: t(i18n)`Sign out`, group: "commands", run: () => reveal("account", [`${target("sign-out")} button`], true) }] : [])
  );
  if (openEditor) commands.push({ id: "editor", label: t(i18n)({ message: "Open in editor", context: "Connect interface" }), group: "commands", run: openEditor });
  if (reviewRequest) commands.push({ id: "review", label: t(i18n)({ message: "Review request", context: "Connect interface" }), group: "commands", run: reviewRequest });
  const keyboard = useConnectKeyboard({ commands, enabled, root: ".connect-main", filter: ".connect-list-filter input", listFocus: ".connect-collection-link, summary", onShow: cancel });
  useEffect(() => () => pending.current?.disconnect(), []);
  return { commands, groupLabels, ...keyboard, cancel };
}
