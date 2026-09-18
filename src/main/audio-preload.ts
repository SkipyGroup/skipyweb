import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('skipyAudio', {
  onStart: (callback: (sourceId: string, db: number, muted: boolean) => void) => {
    ipcRenderer.on('audio:start', (_event, sourceId: string, db: number, muted: boolean) => callback(sourceId, db, muted))
  },
  onUpdate: (callback: (db: number, muted: boolean) => void) => {
    ipcRenderer.on('audio:update', (_event, db: number, muted: boolean) => callback(db, muted))
  },
  onStop: (callback: () => void) => {
    ipcRenderer.on('audio:stop', callback)
  },
  status: (kind: 'active' | 'error', message?: string) => ipcRenderer.send('audio:status', kind, message?.slice(0, 120)),
})
