import { clipboard, ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import path from 'node:path'
import { SdtController } from './sdt-controller'
import { requestApi } from './sdt-api'
import { SdtStore, validateSteps } from './sdt-store'
import type { SdtApiResult, SdtReply, SdtState, SdtStep } from './sdt-types'
import { siteForUrl } from './privacy'

type Target = { id: string; site: string; url: string; contents: WebContents }
type Options = { window: BrowserWindow; dataPath: string; enabled: () => boolean; active: () => Target | null; canShow: () => boolean; changed: () => void }

/** Only this local view can invoke SDT commands. Browser pages never receive its preload. */
export class SdtService {
  private view: WebContentsView | null = null
  private ready = false
  private attached = false
  private opened = false
  private disposed = false
  private controller: SdtController
  private store: SdtStore
  private apiAbort: AbortController | null = null
  private apiResult: SdtApiResult | null = null
  private target: Target | null = null
  private revision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private signature = ''
  private bounds = ''
  private documentPending = false

  constructor(private options: Options) {
    this.store = new SdtStore(path.join(options.dataPath, 'sdt.json'))
    this.store.load()
    this.controller = new SdtController(() => this.changed())
    ipcMain.handle('sdt:command', async (event, action: unknown, payload: unknown): Promise<SdtReply> => {
      if (!this.options.enabled() || !this.opened || !this.view || event.sender !== this.view.webContents || event.senderFrame !== this.view.webContents.mainFrame) return { ok: false, error: 'Az SDT csak bekapcsolt fejlesztői módban használható.' }
      try { await this.command(action, payload); return { ok: true } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Az SDT művelet nem sikerült.' } }
    })
  }
  get isOpen() { return this.opened }
  get isWorking() { return this.controller.snapshot().mode !== 'idle' }

  private state(): SdtState {
    return { enabled: this.options.enabled(), open: this.opened, tabId: this.target?.id ?? null, site: this.target?.site ?? null, url: this.target?.url ?? '', ...this.controller.snapshot(), tests: this.store.list(this.target?.site ?? null), apiRunning: !!this.apiAbort, apiResult: this.apiResult }
  }
  private changed() {
    if (this.disposed || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.layout(); this.publish() }, 16)
  }
  private publish() {
    if (!this.view || !this.ready || this.view.webContents.isDestroyed()) return
    const state = this.state(), signature = JSON.stringify(state)
    if (signature === this.signature) return
    this.signature = signature
    this.view.webContents.send('sdt:state', state)
  }
  bind() {
    const next = this.options.enabled() ? this.options.active() : null
    if (!this.documentPending && this.target?.id === next?.id && this.target?.contents === next?.contents && this.target?.url === next?.url) return
    this.revision++
    this.apiAbort?.abort()
    this.target = next
    this.documentPending = false
    this.controller.bind(next)
    this.changed()
  }
  /** Called before navigation commits, even when the URL has not changed yet. */
  documentNavigation(tabId: string) {
    if (this.target?.id !== tabId) return
    this.revision++
    this.apiAbort?.abort()
    this.documentPending = true
    this.controller.documentNavigation(tabId)
    this.changed()
  }
  /** Called when the tab itself is left, closed or replaced. */
  navigation(tabId: string) {
    if (this.target?.id !== tabId) return
    this.revision++
    this.apiAbort?.abort()
    this.target = null
    this.documentPending = false
    this.controller.bind(null)
    this.changed()
  }
  toggle() { if (this.opened) this.close(); else this.open() }
  private open() {
    if (!this.options.enabled() || this.disposed) return
    this.opened = true
    this.bind()
    this.controller.clearMessage()
    if (!this.view) {
      const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'sdt-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
      this.view = view
      view.setBackgroundColor('#00000000')
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', event => event.preventDefault())
      view.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') { event.preventDefault(); this.close() }
        else if (input.key === 'Escape') { event.preventDefault(); if (this.isWorking) void this.controller.stop('Megszakítva.'); else this.close() }
      })
      view.webContents.on('did-finish-load', () => { this.ready = true; this.signature = ''; this.changed() })
      view.webContents.on('render-process-gone', () => { this.close(); this.ready = false; this.view = null })
      void view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'sdt.html')).catch(() => this.close())
    }
    this.changed()
    this.options.changed()
  }
  close() {
    this.opened = false
    this.revision++
    this.apiAbort?.abort()
    void this.controller.stop('Az SDT bezárult.')
    this.layout()
    this.changed()
    this.options.changed()
  }
  disabled() { this.close(); this.bind() }
  layout() {
    const { window } = this.options
    if (!this.view || window.isDestroyed() || this.view.webContents.isDestroyed()) return
    const visible = this.opened && this.ready && this.options.enabled() && this.options.canShow()
    if (!visible) {
      if (this.attached) window.contentView.removeChildView(this.view)
      this.attached = false
      return
    }
    const [width, height] = window.getContentSize()
    const mode = this.controller.snapshot().mode
    const compact = mode === 'picking' || mode === 'recording'
    const w = Math.min(compact ? 390 : 510, width - 24)
    const h = compact ? 94 : Math.max(150, height - 114)
    const rect = { x: width - w - 12, y: compact ? height - h - 12 : 102, width: w, height: h }
    const signature = JSON.stringify(rect)
    if (signature !== this.bounds) { this.view.setBounds(rect); this.bounds = signature }
    if (!this.attached) { window.contentView.addChildView(this.view); this.attached = true }
  }
  /** Re-raise only after an active page view is replaced; modal overlays remain above SDT. */
  pageAttached() {
    if (this.view && this.attached && !this.options.window.isDestroyed()) { this.options.window.contentView.removeChildView(this.view); this.attached = false }
    this.bind(); this.layout()
  }
  private activeTarget() {
    const target = this.target
    if (!target || target.contents.isDestroyed() || target.contents.isLoadingMainFrame() || this.options.active()?.id !== target.id || siteForUrl(target.contents.getURL()) !== target.site) throw new Error('Nyiss meg egy betöltött HTTP(S) weboldalt.')
    return target
  }
  private steps(input: unknown) {
    const target = this.activeTarget()
    const steps = validateSteps(input)
    for (const step of steps) if (step.kind === 'url' && siteForUrl(step.value ?? '') !== target.site) throw new Error('A teszt URL-ellenőrzése csak az aktuális webhelyhez tartozhat.')
    return steps
  }
  private async command(action: unknown, payload: unknown) {
    if (typeof action !== 'string') throw new Error('Érvénytelen SDT parancs.')
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    if (action === 'state') { this.signature = ''; this.publish(); return }
    if (action === 'close') { this.close(); return }
    if (action === 'stop') { await this.controller.stop('Megszakítva.'); return }
    if (action === 'api-cancel') { this.apiAbort?.abort(); return }
    if (action === 'copy') { if (typeof payload !== 'string' || payload.length > 1024 * 1024) throw new Error('Érvénytelen másolandó szöveg.'); clipboard.writeText(payload); return }
    if (action === 'api-send') {
      if (this.apiAbort) throw new Error('Már folyamatban van egy API-kérés.')
      const abort = new AbortController(), revision = this.revision
      this.apiAbort = abort; this.apiResult = null; this.changed()
      void requestApi(payload, abort.signal).then(result => {
        if (this.apiAbort === abort && this.revision === revision) this.apiResult = result
      }).catch(error => {
        if (this.apiAbort === abort && this.revision === revision) this.apiResult = { status: 0, statusText: '', elapsedMs: 0, headers: [], body: '', bytes: 0, error: String(error) }
      }).finally(() => { if (this.apiAbort === abort) { this.apiAbort = null; this.changed() } })
      return
    }
    this.activeTarget()
    if (action === 'pick-start') { await this.controller.startPicking(); this.target?.contents.focus(); return }
    if (action === 'record-start') { await this.controller.startRecording(); this.target?.contents.focus(); return }
    if (action === 'test-run') { const steps = this.steps(body.steps); void this.controller.run(steps).catch(() => this.changed()); return }
    if (this.isWorking) throw new Error('Előbb állítsd le a rögzítést vagy tesztet.')
    if (action === 'draft-set') this.controller.setDraft(this.steps(payload))
    else if (action === 'test-save') { await this.store.save(this.target!.site, { ...body, steps: this.steps(body.steps) }); this.changed() }
    else if (action === 'test-delete') { if (typeof body.id !== 'string') throw new Error('Hiányzó tesztazonosító.'); await this.store.remove(this.target!.site, body.id); this.changed() }
    else if (action === 'test-load') {
      const test = this.store.list(this.target!.site).find(test => test.id === body.id)
      if (!test) throw new Error('Ez a teszt nem az aktuális webhelyhez tartozik.')
      this.controller.setDraft(test.steps)
    } else throw new Error('Ismeretlen SDT parancs.')
  }
  flush() { return this.store.flush() }
  async dispose() {
    this.disposed = true; this.opened = false; this.apiAbort?.abort(); this.revision++
    if (this.timer) clearTimeout(this.timer)
    await this.controller.dispose()
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.view = null
    ipcMain.removeHandler('sdt:command')
    await this.store.flush()
  }
}
