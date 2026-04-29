import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  selectScope: () => ipcRenderer.invoke("select-scope"),
  getCurrentScope: () => ipcRenderer.invoke("get-current-scope"),
  getRecentScopes: () => ipcRenderer.invoke("get-recent-scopes"),
  switchScope: (scopePath: string) => ipcRenderer.invoke("switch-scope", scopePath),
  browsers: {
    list: () => ipcRenderer.invoke("browser-sessions:list"),
    ensure: (input: unknown) => ipcRenderer.invoke("browser-sessions:ensure", input),
    show: (sessionId: string, bounds: unknown) =>
      ipcRenderer.invoke("browser-sessions:show", sessionId, bounds),
    setBounds: (sessionId: string, bounds: unknown) =>
      ipcRenderer.invoke("browser-sessions:set-bounds", sessionId, bounds),
    hide: (sessionId: string) => ipcRenderer.invoke("browser-sessions:hide", sessionId),
    navigate: (sessionId: string, url: string) =>
      ipcRenderer.invoke("browser-sessions:navigate", sessionId, url),
    back: (sessionId: string) => ipcRenderer.invoke("browser-sessions:back", sessionId),
    forward: (sessionId: string) => ipcRenderer.invoke("browser-sessions:forward", sessionId),
    reload: (sessionId: string) => ipcRenderer.invoke("browser-sessions:reload", sessionId),
    touch: (sessionId: string, input: unknown) =>
      ipcRenderer.invoke("browser-sessions:touch", sessionId, input),
    close: (sessionId: string) => ipcRenderer.invoke("browser-sessions:close", sessionId),
    onChanged: (listener: (sessions: unknown) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, sessions: unknown) => {
        listener(sessions);
      };
      ipcRenderer.on("browser-sessions-changed", wrapped);
      return () => ipcRenderer.off("browser-sessions-changed", wrapped);
    },
  },
});
