import { ipcRenderer, contextBridge } from 'electron'
import { IPC } from '../src/types/index.ts'
import type { AppConfig, ElectronAPI } from '../src/types/index.ts'

// Expose only the IPC surface listed in spec §17.
// No raw ipcRenderer access — each method is explicitly typed and scoped.
const api: ElectronAPI = {
  // Send a command string to the PTY.
  // Main process strips everything after the first newline (§8c).
  ptyWrite(data: string) {
    ipcRenderer.send(IPC.PTY_WRITE, data)
  },

  // Notify the PTY of terminal dimension changes.
  ptyResize(cols: number, rows: number) {
    ipcRenderer.send(IPC.PTY_RESIZE, cols, rows)
  },

  // Subscribe to PTY data chunks. Returns an unsubscribe function.
  onPtyData(cb: (data: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, data: string) => cb(data)
    ipcRenderer.on(IPC.PTY_DATA, handler)
    return () => ipcRenderer.off(IPC.PTY_DATA, handler)
  },

  // Subscribe to PTY exit events. Returns an unsubscribe function.
  onPtyExit(cb: (code: number) => void) {
    const handler = (_event: Electron.IpcRendererEvent, code: number) => cb(code)
    ipcRenderer.on(IPC.PTY_EXIT, handler)
    return () => ipcRenderer.off(IPC.PTY_EXIT, handler)
  },

  // Subscribe to CWD change events (OSC 1337 stripped in main process).
  onPtyCwd(cb: (cwd: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, cwd: string) => cb(cwd)
    ipcRenderer.on(IPC.PTY_CWD, handler)
    return () => ipcRenderer.off(IPC.PTY_CWD, handler)
  },

  // Read the current persisted config.
  configGet(): Promise<AppConfig> {
    return ipcRenderer.invoke(IPC.CONFIG_GET)
  },

  // Merge a partial config update into persisted config.
  configSet(partial: Partial<AppConfig>): Promise<void> {
    return ipcRenderer.invoke(IPC.CONFIG_SET, partial)
  },

  // Subscribe to installer progress events (first-run only).
  onInstallStatus(cb) {
    const handler = (_event: Electron.IpcRendererEvent, status: Parameters<typeof cb>[0]) => cb(status)
    ipcRenderer.on(IPC.INSTALL_STATUS, handler)
    return () => ipcRenderer.off(IPC.INSTALL_STATUS, handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
