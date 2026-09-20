import { contextBridge, ipcRenderer } from 'electron'
import type { SdtState } from './sdt-types'

contextBridge.exposeInMainWorld('sdt', {
  command: (action: string, payload?: unknown) => ipcRenderer.invoke('sdt:command', action, payload),
  onState: (callback: (state: SdtState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SdtState) => callback(state)
    ipcRenderer.on('sdt:state', listener)
    return () => ipcRenderer.removeListener('sdt:state', listener)
  },
})
