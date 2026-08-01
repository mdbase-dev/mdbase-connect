import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateStatus } from "./update-coordinator";

type ContractSetupChoice =
  | { contract: { id: string; version: string }; mode: "starter" }
  | {
      contract: { id: string; version: string };
      mode: "existing";
      type_name: string;
      type_revision: string;
      fields: Record<string, string>;
      binding?: Record<string, unknown>;
    };

type DesktopSelectiveSyncPolicy = {
  file_classes: Array<"image" | "audio" | "video" | "pdf" | "other">;
  excluded_folders: string[];
};

contextBridge.exposeInMainWorld("mdbaseConnect", {
  status: () => ipcRenderer.invoke("connect:status"),
  updateStatus: () => ipcRenderer.invoke("connect:updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("connect:updates:check"),
  installUpdate: () => ipcRenderer.invoke("connect:updates:install"),
  listCollections: () => ipcRenderer.invoke("connect:collections:list"),
  addCollection: () => ipcRenderer.invoke("connect:collections:add"),
  addCopiedCollection: (path: string) =>
    ipcRenderer.invoke("connect:collections:add-copy", path),
  makeCollectionIndependent: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:make-independent", collectionId),
  takeCollectionAuthority: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:take-authority", collectionId),
  transferCollectionAuthority: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:transfer-authority", collectionId),
  chooseCreateFolder: () => ipcRenderer.invoke("connect:collections:choose-create"),
  createCollection: (input: { path: string; name: string }) =>
    ipcRenderer.invoke("connect:collections:create", input),
  updateCollectionMetadata: (input: { collectionId: string; name: string; description?: string }) =>
    ipcRenderer.invoke("connect:collections:update-metadata", input),
  setCollectionEnabled: (collectionId: string, enabled: boolean) =>
    ipcRenderer.invoke("connect:collections:set-enabled", { collectionId, enabled }),
  validateCollection: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:validate", collectionId),
  removeCollection: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:remove", collectionId),
  openPath: (path: string) => ipcRenderer.invoke("connect:path:open", path),
  openCollectionConfig: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:open-config", collectionId),
  openEditor: (collectionId: string) =>
    ipcRenderer.invoke("connect:editor:open", collectionId),
  getLaunchAtLogin: () => ipcRenderer.invoke("connect:startup:get"),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke("connect:startup:set", enabled),
  getCloudConfig: () => ipcRenderer.invoke("connect:cloud:get"),
  openAccount: () => ipcRenderer.invoke("connect:account:open"),
  setCloudConfig: (input: { serverUrl: string; connectorToken: string }) =>
    ipcRenderer.invoke("connect:cloud:set", input),
  clearCloudConfig: () => ipcRenderer.invoke("connect:cloud:clear"),
  beginPairing: (input: { serverUrl: string; connectorName: string }) =>
    ipcRenderer.invoke("connect:pairing:begin", input),
  pairingStatus: (pairingId: string) => ipcRenderer.invoke("connect:pairing:status", pairingId),
  accessSnapshot: () => ipcRenderer.invoke("connect:access:snapshot"),
  setAccessPaused: (paused: boolean) => ipcRenderer.invoke("connect:access:pause", paused),
  renameComputer: (name: string) => ipcRenderer.invoke("connect:account:rename-computer", name),
  createGrant: (input: { applicationId: string; collectionId: string; operations: string[] }) =>
    ipcRenderer.invoke("connect:grants:create", input),
  updateGrant: (input: { grantId: string; operations: string[] }) =>
    ipcRenderer.invoke("connect:grants:update", input),
  revokeGrant: (grantId: string) => ipcRenderer.invoke("connect:grants:revoke", grantId),
  approveAuthorization: (input: {
    requestId: string;
    collectionId: string;
    operations: string[];
    contractSetups?: ContractSetupChoice[];
  }) =>
    ipcRenderer.invoke("connect:authorizations:approve", input),
  denyAuthorization: (requestId: string) => ipcRenderer.invoke("connect:authorizations:deny", requestId),
  listActivity: (limit = 100) => ipcRenderer.invoke("connect:activity:list", limit),
  hostedSnapshot: () => ipcRenderer.invoke("connect:hosted:snapshot"),
  createHostedCollection: (name: string) => ipcRenderer.invoke("connect:hosted:create", name),
  renameHostedCollection: (input: { collectionId: string; name: string }) =>
    ipcRenderer.invoke("connect:hosted:rename", input),
  deleteHostedCollection: (collectionId: string) =>
    ipcRenderer.invoke("connect:hosted:delete", collectionId),
  approveHostedAuthorization: (input: {
    requestId: string;
    collectionId: string;
    operations: string[];
    contractSetups?: ContractSetupChoice[];
  }) => ipcRenderer.invoke("connect:hosted:authorization-approve", input),
  updateHostedGrant: (input: { grantId: string; operations: string[] }) =>
    ipcRenderer.invoke("connect:hosted:grant-update", input),
  revokeHostedGrant: (grantId: string) =>
    ipcRenderer.invoke("connect:hosted:grant-revoke", grantId),
  revokeHostedReplica: (replicaId: string) =>
    ipcRenderer.invoke("connect:hosted:replica-revoke", replicaId),
  listMirrors: () => ipcRenderer.invoke("connect:mirrors:list"),
  chooseMirrorFolder: () => ipcRenderer.invoke("connect:mirrors:choose-folder"),
  connectMirror: (input: {
    collectionId: string;
    path: string;
    mode: "read_only" | "read_write";
    name?: string;
    selectiveSync: DesktopSelectiveSyncPolicy;
  }) => ipcRenderer.invoke("connect:mirrors:connect", input),
  syncMirror: (replicaId: string) => ipcRenderer.invoke("connect:mirrors:sync", replicaId),
  configureMirrorSelectiveSync: (input: {
    replicaId: string;
    selectiveSync: DesktopSelectiveSyncPolicy;
  }) => ipcRenderer.invoke("connect:mirrors:configure-selective-sync", input),
  resolveMirrorConflict: (input: {
    replicaId: string;
    recordId: string;
    resolution: "local" | "remote";
  }) => ipcRenderer.invoke("connect:mirrors:resolve", input),
  promoteMirrorAuthority: (replicaId: string) =>
    ipcRenderer.invoke("connect:mirrors:promote", replicaId),
  disconnectMirror: (replicaId: string) =>
    ipcRenderer.invoke("connect:mirrors:disconnect", replicaId),
  openMirror: (replicaId: string) => ipcRenderer.invoke("connect:mirrors:open", replicaId),
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
