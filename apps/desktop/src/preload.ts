import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getCurrentScope: () => ipcRenderer.invoke("get-current-scope"),
  cloudAuth: {
    me: () => ipcRenderer.invoke("cloud-auth:me"),
    signIn: () => ipcRenderer.invoke("cloud-auth:sign-in"),
    signOut: () => ipcRenderer.invoke("cloud-auth:sign-out"),
    getCloudUrl: () => ipcRenderer.invoke("cloud-auth:get-cloud-url"),
    getDeviceId: () => ipcRenderer.invoke("cloud-auth:get-device-id"),
    getEntitlements: () => ipcRenderer.invoke("cloud-auth:get-entitlements"),
    openBillingPlans: () => ipcRenderer.invoke("cloud-auth:open-billing-plans"),
    startRawComposioConnect: (payload: unknown) =>
      ipcRenderer.invoke("cloud-auth:start-raw-composio-connect", payload),
    listSources: () => ipcRenderer.invoke("cloud-auth:list-sources"),
    syncSourcesToCloud: (sourceIds: string[]) =>
      ipcRenderer.invoke("cloud-auth:source-sync-to-cloud", sourceIds),
    syncSourcesToLocal: (sourceIds: string[]) =>
      ipcRenderer.invoke("cloud-auth:source-sync-to-local", sourceIds),
    deleteSources: (sourceIds: string[], placements: ("local" | "cloud")[]) =>
      ipcRenderer.invoke("cloud-auth:source-sync-delete", sourceIds, placements),
    listImportCandidates: () => ipcRenderer.invoke("cloud-auth:source-sync-import-candidates"),
  },
  files: {
    list: () => ipcRenderer.invoke("workspace-files:list"),
    read: (path: string) => ipcRenderer.invoke("workspace-files:read", path),
    write: (path: string, content: string) =>
      ipcRenderer.invoke("workspace-files:write", path, content),
    createFile: (path: string, content?: string) =>
      ipcRenderer.invoke("workspace-files:create-file", path, content),
    createDirectory: (path: string) => ipcRenderer.invoke("workspace-files:create-directory", path),
    moveFile: (sourcePath: string, destinationDirectoryPath: string) =>
      ipcRenderer.invoke("workspace-files:move-file", sourcePath, destinationDirectoryPath),
    getDroppedFilePaths: (files: File[]) =>
      files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
    importPaths: (sourcePaths: string[], destinationDirectoryPath: string) =>
      ipcRenderer.invoke("workspace-files:import-paths", sourcePaths, destinationDirectoryPath),
    getFileUrl: (path: string) => ipcRenderer.invoke("workspace-files:get-file-url", path),
    open: (
      path: string,
      target:
        | "default"
        | "file-manager"
        | "cursor"
        | "zed"
        | "vscode"
        | "vscode-insiders"
        | "vscodium",
    ) => ipcRenderer.invoke("workspace-files:open", path, target),
  },
  browsers: {
    list: () => ipcRenderer.invoke("browser-sessions:list"),
    ensure: (input: unknown) => ipcRenderer.invoke("browser-sessions:ensure", input),
    activateViewport: () => ipcRenderer.invoke("browser-sessions:activate-viewport"),
    deactivateViewport: () => ipcRenderer.invoke("browser-sessions:deactivate-viewport"),
    show: (sessionId: string, bounds: unknown) =>
      ipcRenderer.invoke("browser-sessions:show", sessionId, bounds),
    setBounds: (sessionId: string, bounds: unknown) =>
      ipcRenderer.invoke("browser-sessions:set-bounds", sessionId, bounds),
    hide: (sessionId: string) => ipcRenderer.invoke("browser-sessions:hide", sessionId),
    rename: (sessionId: string, sessionName: string) =>
      ipcRenderer.invoke("browser-sessions:rename", sessionId, sessionName),
    navigate: (sessionId: string, url: string) =>
      ipcRenderer.invoke("browser-sessions:navigate", sessionId, url),
    back: (sessionId: string) => ipcRenderer.invoke("browser-sessions:back", sessionId),
    forward: (sessionId: string) => ipcRenderer.invoke("browser-sessions:forward", sessionId),
    reload: (sessionId: string) => ipcRenderer.invoke("browser-sessions:reload", sessionId),
    touch: (sessionId: string, input: unknown) =>
      ipcRenderer.invoke("browser-sessions:touch", sessionId, input),
    close: (sessionId: string) => ipcRenderer.invoke("browser-sessions:close", sessionId),
    clearBrowserData: () => ipcRenderer.invoke("browser-data:clear"),
    onChanged: (listener: (sessions: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, sessions: unknown) => {
        listener(sessions);
      };
      ipcRenderer.on("browser-sessions-changed", wrapped);
      return () => ipcRenderer.off("browser-sessions-changed", wrapped);
    },
  },
});
