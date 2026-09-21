import { clipboard, dialog, ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
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
    this.controller = new SdtController(() => this.changed(), path.join(options.dataPath,'sdt-artifacts'), run => { void this.store.addRun(run).then(()=>this.cleanupArtifacts()).then(()=>this.changed()) })
    ipcMain.handle('sdt:command', async (event, action: unknown, payload: unknown): Promise<SdtReply> => {
      if (!this.options.enabled() || !this.opened || !this.view || event.sender !== this.view.webContents || event.senderFrame !== this.view.webContents.mainFrame) return { ok: false, error: 'Az SDT csak bekapcsolt fejlesztői módban használható.' }
      try { const data=await this.command(action, payload); return { ok: true, ...(data===undefined?{}:{data}) } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Az SDT művelet nem sikerült.' } }
    })
  }
  get isOpen() { return this.opened }
  get isWorking() { return this.controller.snapshot().mode !== 'idle' }
  private async cleanupArtifacts(){const dir=path.join(this.options.dataPath,'sdt-artifacts'),keep=this.store.artifactPaths();try{for(const name of await fs.promises.readdir(dir)){const file=path.join(dir,name);if(!keep.has(file))await fs.promises.rm(file,{force:true})}}catch{/* No artifacts yet. */}}

  private state(): SdtState {
    return { enabled: this.options.enabled(), open: this.opened, tabId: this.target?.id ?? null, site: this.target?.site ?? null, url: this.target?.url ?? '', ...this.controller.snapshot(), tests: this.store.list(this.target?.site ?? null), projects:this.store.listProjects(this.target?.site??null),suites:this.store.listSuites(this.target?.site??null), runs: this.store.listRuns(this.target?.site ?? null), apiRunning: !!this.apiAbort, apiResult: this.apiResult }
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
    for (const step of steps) if (step.kind === 'url' && !step.value?.includes('${') && siteForUrl(step.value ?? '') !== target.site) throw new Error('A teszt URL-ellenőrzése csak az aktuális webhelyhez tartozhat.')
    return steps
  }
  private resolvedSteps(input:unknown,runtime:Record<string,string>={}){
    const steps=this.steps(input),project=this.store.listProjects(this.target!.site)[0]
    const values:Record<string,string>={baseUrl:project?.baseUrl??'',...(project?.variables??{}),...runtime}
    const replace=(value:string|undefined,step:SdtStep)=>value?.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_all,key:string)=>{if(values[key]===undefined)throw new Error(`Hiányzó változó: ${key} · ${step.name||step.id}`);return values[key]})
    const resolved=steps.map(step=>({...step,value:replace(step.value,step),expectedValue:replace(step.expectedValue,step)}))
    for(const step of resolved)if(step.kind==='url'&&siteForUrl(step.value??'')!==this.target!.site)throw new Error('A feloldott URL másik webhelyre mutat.')
    return resolved
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
    if (action === 'test-run' || action === 'start') {
      const secrets=body.secrets&&typeof body.secrets==='object'?body.secrets as Record<string,string>:{},variables=body.variables&&typeof body.variables==='object'?body.variables as Record<string,string>:{},steps=this.resolvedSteps(body.steps,variables),name=typeof body.name==='string'?body.name:'UI teszt'
      for(const step of steps)if(step.kind==='input'&&step.sensitive&&typeof secrets[step.id]!=='string')throw new Error(`Hiányzó futásidejű érték: ${step.selector||step.id}`)
      return await new Promise<string>((resolve,reject)=>{let acknowledged=false;void this.controller.run(steps,secrets,name,id=>{acknowledged=true;resolve(id)}).catch(error=>{if(!acknowledged)reject(error);else this.changed()})})
    }
    if(action==='suite-run'){
      if(typeof body.suiteId!=='string')throw new Error('Válassz tesztcsomagot.');const tests=this.store.list(this.target!.site).filter(test=>test.suiteId===body.suiteId);if(!tests.length)throw new Error('A tesztcsomag üres.');const secrets=body.secrets&&typeof body.secrets==='object'?body.secrets as Record<string,string>:{},variables=body.variables&&typeof body.variables==='object'?body.variables as Record<string,string>:{};return await new Promise<string>((resolve,reject)=>{let ack=false;void(async()=>{for(const test of tests){const steps=this.resolvedSteps(test.steps,variables);await this.controller.run(steps,secrets,`${test.name} · csomag`,id=>{if(!ack){ack=true;resolve(id)}})}})().catch(error=>{if(!ack)reject(error);else this.changed()})})
    }
    if (this.isWorking) throw new Error('Előbb állítsd le a rögzítést vagy tesztet.')
    if (action === 'draft-set') this.controller.setDraft(this.steps(payload))
    else if (action === 'test-save') { await this.store.save(this.target!.site, { ...body, steps: this.steps(body.steps) }); this.changed() }
    else if (action === 'test-delete') { if (typeof body.id !== 'string') throw new Error('Hiányzó tesztazonosító.'); await this.store.remove(this.target!.site, body.id); this.changed() }
    else if(action==='runs-clear'){await this.store.clearRuns(this.target!.site);this.changed()}
    else if(action==='suite-create'){if(typeof body.name!=='string')throw new Error('Adj nevet a tesztcsomagnak.');return await this.store.createSuite(this.target!.site,body.name)}
    else if(action==='project-save'){await this.store.updateProject(this.target!.site,body);this.changed()}
    else if(action==='run-export'){
      if(typeof body.id!=='string'||!['html','json'].includes(String(body.format)))throw new Error('Érvénytelen riport.')
      const run=this.store.listRuns(this.target!.site).find(item=>item.id===body.id);if(!run)throw new Error('A futás nem található.')
      const format=String(body.format),selected=await dialog.showSaveDialog(this.options.window,{title:'SDT riport exportálása',defaultPath:path.join(process.env.USERPROFILE||'',`sdt-${run.name.replace(/[^\w-]+/g,'_')}.${format}`),filters:[{name:format.toUpperCase(),extensions:[format]}]});if(selected.canceled||!selected.filePath)return
      if(format==='json')await fs.promises.writeFile(selected.filePath,JSON.stringify(run,null,2),'utf8')
      else{const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));let rows='';for(const result of run.results){let image='';if(result.screenshot){try{image=`<img src="data:image/png;base64,${(await fs.promises.readFile(result.screenshot)).toString('base64')}">`}catch{}}rows+=`<article><h3>${esc(result.id)} · ${esc(result.status)} · ${result.durationMs||0} ms</h3><p>${esc(result.message)}</p>${image}</article>`}await fs.promises.writeFile(selected.filePath,`<!doctype html><meta charset="utf-8"><title>${esc(run.name)}</title><style>body{font:14px system-ui;background:#111;color:#eee;max-width:1000px;margin:auto;padding:30px}article{padding:14px;border:1px solid #444;margin:10px 0}img{max-width:100%}</style><h1>${esc(run.name)}</h1><p>${run.passed} sikeres · ${run.failed} hibás · ${run.durationMs} ms</p>${rows}`,'utf8')}
    }
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
