import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateStatus } from "./update-coordinator";

contextBridge.exposeInMainWorld("mdbaseConnect", {
  getLocale: () => ipcRenderer.invoke("connect:locale:get"),
  setLocale: (locale: string) => ipcRenderer.invoke("connect:locale:set", locale),
  status: () => ipcRenderer.invoke("connect:status"),
  updateStatus: () => ipcRenderer.invoke("connect:updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("connect:updates:check"),
  installUpdate: () => ipcRenderer.invoke("connect:updates:install"),
  migrationStatus: () => ipcRenderer.invoke("connect:migration:status"),
  startMigration: (stopMirrors: boolean) => ipcRenderer.invoke("connect:migration:start", { stopMirrors }),
  listCollections: () => ipcRenderer.invoke("connect:collections:list"),
  addCollection: () => ipcRenderer.invoke("connect:collections:add"),
  chooseCreateFolder: () => ipcRenderer.invoke("connect:collections:choose-create"),
  createCollection: (input: { parent: string; name: string }) =>
    ipcRenderer.invoke("connect:collections:create", input),
  removeCollection: (collectionId: string) => ipcRenderer.invoke("connect:collections:remove", collectionId),
  setCollectionEnabled: (collectionId: string, enabled: boolean) =>
    ipcRenderer.invoke("connect:collections:set-enabled", { collectionId, enabled }),
  enableSync: (collectionId: string, mode: "private" | "cloud-copy", acceptTakeoverHolds: boolean) =>
    ipcRenderer.invoke("connect:collections:sync-enable", { collectionId, mode, acceptTakeoverHolds }),
  collectionModeStatus: (collectionId: string) => ipcRenderer.invoke("connect:collections:mode-status", collectionId),
  changeCollectionMode: (collectionId: string, targetMode: "private" | "cloud_copy", resume: boolean, cancel = false) =>
    ipcRenderer.invoke("connect:collections:mode-change", { collectionId, targetMode, resume, cancel }),
  disableSync: (collectionId: string) => ipcRenderer.invoke("connect:collections:sync-disable", collectionId),
  listHolds: (collectionId: string) => ipcRenderer.invoke("connect:collections:holds", collectionId),
  resolveHold: (collectionId: string, id: string, how: "keep_mine" | "take_theirs" | "keep_both" | "delete") =>
    ipcRenderer.invoke("connect:collections:resolve-hold", { collectionId, id, how }),
  openCollectionFolder: (collectionId: string) => ipcRenderer.invoke("connect:collections:open-folder", collectionId),
  openEditor: (collectionId: string) => ipcRenderer.invoke("connect:editor:open", collectionId),
  getLaunchAtLogin: () => ipcRenderer.invoke("connect:startup:get"),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke("connect:startup:set", enabled),
  getCloudConfig: () => ipcRenderer.invoke("connect:cloud:get"),
  openAccount: () => ipcRenderer.invoke("connect:account:open"),
  signIn: () => ipcRenderer.invoke("connect:account:sign-in"),
  reopenSignIn: () => ipcRenderer.invoke("connect:account:reopen-sign-in"),
  signOut: () => ipcRenderer.invoke("connect:account:sign-out"),
  renameComputer: (name: string) => ipcRenderer.invoke("connect:account:rename", name),
  listActivity: () => ipcRenderer.invoke("connect:activity:list"),
  updateCollection: (collectionId: string, changes: { name?: string; description?: string }) =>
    ipcRenderer.invoke("connect:collections:update", { collectionId, ...changes }),
  listAccess: () => ipcRenderer.invoke("connect:access:list"),
  approveAccess: (grant: string) => ipcRenderer.invoke("connect:access:approve", grant),
  acknowledgeAccess: (grant: string) => ipcRenderer.invoke("connect:access:ack", grant),
  denyAccess: (grant: string) => ipcRenderer.invoke("connect:access:deny", grant),
  revokeAccess: (grant: string) => ipcRenderer.invoke("connect:access:revoke", grant),
  listPendingDevices: () => ipcRenderer.invoke("connect:devices:pending"),
  approveDevice: (collectionId: string, device: string, sas: string) =>
    ipcRenderer.invoke("connect:devices:approve", { collectionId, device, sas }),
  rejectDevice: (collectionId: string, device: string) =>
    ipcRenderer.invoke("connect:devices:reject", { collectionId, device }),
  getSettings: () => ipcRenderer.invoke("connect:settings:get"),
  setRequireApproval: (on: boolean) => ipcRenderer.invoke("connect:settings:require-approval", on),
  onNavigate: (listener: (route: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, route: string) => listener(route);
    ipcRenderer.on("connect:navigate", handler);
    return () => ipcRenderer.removeListener("connect:navigate", handler);
  },
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) =>
      listener(status);
    ipcRenderer.on("connect:update-status", handler);
    return () => ipcRenderer.removeListener("connect:update-status", handler);
  }
});
