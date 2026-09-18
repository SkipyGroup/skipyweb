const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

try {
  const config = ipcRenderer.sendSync('privacy:fingerprint-config') as { seed: number; enabled: boolean } | null
  if (!config || typeof config.seed !== 'number') throw new Error('Missing fingerprint configuration')
  contextBridge.executeInMainWorld({ func: installFingerprint, args: [config.seed, config.enabled] })
  ipcRenderer.send('privacy:fingerprint-status', true)
} catch {
  ipcRenderer.send('privacy:fingerprint-status', false)
}
