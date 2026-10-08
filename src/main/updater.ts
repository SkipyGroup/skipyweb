import { app, net } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error'
  version: string | null
  currentVersion: string
  progress: number // 0–100
  errorMessage: string | null
  autoCheck: boolean
}

export class UpdateService {
  private state: UpdateState = {
    status: 'idle',
    version: null,
    currentVersion: app.getVersion(),
    progress: 0,
    errorMessage: null,
    autoCheck: true,
  }

  private onChange: () => void

  constructor(onChange: () => void) {
    this.onChange = onChange

    if (!app.isPackaged) {
      // In dev mode electron-updater cannot reach GitHub Releases.
      // We simulate the capability via the GitHub REST API instead.
      return
    }

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => {
      this.state = { ...this.state, status: 'checking', errorMessage: null }
      this.onChange()
    })

    autoUpdater.on('update-available', info => {
      this.state = { ...this.state, status: 'available', version: info.version }
      this.onChange()
    })

    autoUpdater.on('update-not-available', () => {
      this.state = { ...this.state, status: 'not-available', version: null }
      this.onChange()
    })

    autoUpdater.on('download-progress', progress => {
      this.state = { ...this.state, status: 'downloading', progress: Math.round(progress.percent) }
      this.onChange()
    })

    autoUpdater.on('update-downloaded', info => {
      this.state = { ...this.state, status: 'ready', version: info.version, progress: 100 }
      this.onChange()
    })

    autoUpdater.on('error', err => {
      this.state = { ...this.state, status: 'error', errorMessage: err.message ?? 'Ismeretlen hiba' }
      this.onChange()
    })
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  updateAutoCheck(value: boolean) {
    this.state = { ...this.state, autoCheck: value }
    this.onChange()
  }

  async checkForUpdates(): Promise<void> {
    if (app.isPackaged) {
      try {
        await autoUpdater.checkForUpdates()
      } catch (err: unknown) {
        this.state = { ...this.state, status: 'error', errorMessage: err instanceof Error ? err.message : 'Hálózati hiba' }
        this.onChange()
      }
      return
    }

    // ---- Dev-mode simulation via GitHub REST API ----
    this.state = { ...this.state, status: 'checking', errorMessage: null }
    this.onChange()
    try {
      const response = await net.fetch('https://api.github.com/repos/SkipyGroup/skipyweb/releases/latest', {
        headers: { 'User-Agent': `SkipyBrowser/${app.getVersion()}`, 'Accept': 'application/vnd.github+json' }
      })
      if (!response.ok) throw new Error(`GitHub API: ${response.status}`)
      const data = await response.json() as { tag_name?: string }
      const latestVersion = (data.tag_name ?? '').replace(/^v/, '')
      if (!latestVersion) { this.state = { ...this.state, status: 'not-available' }; this.onChange(); return }
      const current = app.getVersion()
      const isNewer = latestVersion.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0
      if (isNewer) {
        this.state = { ...this.state, status: 'available', version: latestVersion }
      } else {
        this.state = { ...this.state, status: 'not-available', version: null }
      }
    } catch (err: unknown) {
      this.state = { ...this.state, status: 'error', errorMessage: err instanceof Error ? err.message : 'Hálózati hiba' }
    }
    this.onChange()
  }

  async downloadUpdate(): Promise<void> {
    if (!app.isPackaged) {
      // In dev mode just open the releases page
      const { shell } = await import('electron')
      void shell.openExternal('https://github.com/SkipyGroup/skipyweb/releases/latest')
      return
    }
    try {
      this.state = { ...this.state, status: 'downloading', progress: 0 }
      this.onChange()
      await autoUpdater.downloadUpdate()
    } catch (err: unknown) {
      this.state = { ...this.state, status: 'error', errorMessage: err instanceof Error ? err.message : 'Letöltési hiba' }
      this.onChange()
    }
  }

  installUpdate(): void {
    if (!app.isPackaged) return
    if (this.state.status === 'ready') autoUpdater.quitAndInstall()
  }
}
