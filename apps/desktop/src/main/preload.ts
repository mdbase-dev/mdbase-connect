import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mdbaseConnect", {
  status: () => ipcRenderer.invoke("connect:status"),
  listCollections: () => ipcRenderer.invoke("connect:collections:list"),
  addCollection: () => ipcRenderer.invoke("connect:collections:add"),
  addCopiedCollection: (path: string) =>
    ipcRenderer.invoke("connect:collections:add-copy", path),
  makeCollectionIndependent: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:make-independent", collectionId),
  takeCollectionAuthority: (collectionId: string) =>
    ipcRenderer.invoke("connect:collections:take-authority", collectionId),
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
  getLaunchAtLogin: () => ipcRenderer.invoke("connect:startup:get"),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke("connect:startup:set", enabled),
  getCloudConfig: () => ipcRenderer.invoke("connect:cloud:get"),
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
  approveAuthorization: (input: { requestId: string; collectionId: string; operations: string[] }) =>
    ipcRenderer.invoke("connect:authorizations:approve", input),
  denyAuthorization: (requestId: string) => ipcRenderer.invoke("connect:authorizations:deny", requestId),
  listActivity: (limit = 100) => ipcRenderer.invoke("connect:activity:list", limit),
  onNavigate: (listener: (route: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, route: string) => listener(route);
    ipcRenderer.on("connect:navigate", handler);
    return () => ipcRenderer.removeListener("connect:navigate", handler);
  }
});
