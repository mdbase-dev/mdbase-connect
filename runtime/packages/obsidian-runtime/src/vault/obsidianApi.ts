/**
 * The parts of Obsidian's API the vault platform uses, structurally typed so
 * the platform can be tested against a fake and doesn't import `obsidian`.
 */

export interface ObsStat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

export interface ObsAdapter {
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  stat(path: string): Promise<ObsStat | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  append?(path: string, data: string): Promise<void>;
  appendBinary?(path: string, data: ArrayBuffer): Promise<void>;
  process(path: string, fn: (data: string) => string): Promise<string>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  /** `FileSystemAdapter` only (desktop). */
  getBasePath?(): string;
  /** Desktop `FileSystemAdapter`: the volume is case-insensitive. */
  insensitive?: boolean;
}

/** `TAbstractFile`/`TFile`, as much as is used. */
export interface ObsFile {
  path: string;
  stat?: { size: number; mtime: number; ctime: number };
  extension?: string;
}

export interface ObsVault {
  adapter: ObsAdapter;
  getFileByPath?(path: string): ObsFile | null;
  getAbstractFileByPath(path: string): ObsFile | null;
  process(file: ObsFile, fn: (data: string) => string): Promise<string>;
  create(path: string, data: string): Promise<ObsFile>;
  createBinary(path: string, data: ArrayBuffer): Promise<ObsFile>;
  rename(file: ObsFile, newPath: string): Promise<void>;
  on(name: "create" | "modify" | "delete", cb: (file: ObsFile) => void): unknown;
  on(name: "rename", cb: (file: ObsFile, oldPath: string) => void): unknown;
  offref(ref: unknown): void;
}

export interface ObsApp {
  vault: ObsVault;
  fileManager: { trashFile(file: ObsFile): Promise<void> };
  /** Private: `app.internalPlugins.getPluginById("sync")`. */
  internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: { vaultId?: string | null } } | null };
  /** Private: `app.plugins.enabledPlugins`. */
  plugins?: { enabledPlugins?: Set<string> };
}

/** `Platform` from `obsidian`. */
export interface ObsPlatform {
  isMobileApp: boolean;
  isAndroidApp: boolean;
  isIosApp: boolean;
}
