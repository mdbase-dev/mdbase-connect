import { MdbaseAppMark } from "@mdbase-dev/ui/brand";
import type { ReactNode } from "react";
import type { CollectionAppIdentity, LeaveIntent } from "@mdbase-dev/ui/collections";
import manifest from "../public/.well-known/mdbase-app.json";

/** The editor's identity in the shared collection screens. */
export const editorCollectionApp: CollectionAppIdentity = { name: manifest.name, mark: <MdbaseAppMark app="editor" /> };

/** The rail's collection switcher; the editor supplies its unsaved-work guard. */
export type EditorCollectionSwitcher = (onBeforeLeave: (intent: LeaveIntent) => boolean | Promise<boolean>) => ReactNode;
