import type { ContractCatalog } from "./contract-catalog";

export type AppPhase = "starting" | "disconnected" | "loading" | "ready";
export type MobilePane = "collections" | "notes" | "editor";
export type Surface = "notes" | "types" | "settings";
export type ConnectionState = "connected" | "reconnecting";
export type ContractCatalogLoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; catalog: ContractCatalog }
  | { status: "error"; message: string };

export interface MobileHistoryState {
  mdbaseEditor: true;
  pane: MobilePane;
  surface: Surface;
}

export interface CreationContext {
  folder?: string;
  tag?: string;
  type?: string;
}
