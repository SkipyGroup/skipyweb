import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('browser', {
  command: (action: string, value?: string) => ipcRenderer.invoke('browser:command', action, value),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('browser:state', listener)
    return () => ipcRenderer.removeListener('browser:state', listener)
  },
  onFocusAddress: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('browser:focus-address', listener)
    return () => ipcRenderer.removeListener('browser:focus-address', listener)
  },
  onOverlayClose: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('browser:overlay-close', listener)
    return () => ipcRenderer.removeListener('browser:overlay-close', listener)
  },
  onDownloadLand: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('browser:download-land', listener)
    return () => ipcRenderer.removeListener('browser:download-land', listener)
  },
})
