import type { ContractCatalog } from "./contract-catalog";

export type AppPhase = "starting" | "disconnected" | "loading" | "ready";
export type MobilePane = "collections" | "notes" | "editor";
export type Surface = "notes" | "types" | "settings";
export type ConnectionState = "connected" | "reconnecting" | "stopped";
export type ContractCatalogLoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; catalog: ContractCatalog }
  | { status: "error"; message: string };

export interface MobileHistoryState {
  mdbaseEditor: true;
  pane: MobilePane;
  surface: Surface;
}

export function isMobileHistoryState(value: unknown): value is MobileHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<MobileHistoryState>;
  return state.mdbaseEditor === true
    && (state.pane === "collections" || state.pane === "notes" || state.pane === "editor")
    && (state.surface === "notes" || state.surface === "types" || state.surface === "settings");
}

export interface CreationContext {
  folder?: string;
  tag?: string;
  type?: string;
}
