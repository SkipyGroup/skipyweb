import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('skipyAudio', {
  onStart: (callback: (db: number, frequency: number, muted: boolean) => void) => {
    ipcRenderer.on('audio:start', (_event, db: number, frequency: number, muted: boolean) => callback(db, frequency, muted))
  },
  onUpdate: (callback: (db: number, frequency: number, muted: boolean) => void) => {
    ipcRenderer.on('audio:update', (_event, db: number, frequency: number, muted: boolean) => callback(db, frequency, muted))
  },
  onStop: (callback: () => void) => {
    ipcRenderer.on('audio:stop', callback)
  },
  status: (kind: 'active' | 'error', message?: string) => ipcRenderer.send('audio:status', kind, message?.slice(0, 120)),
})
