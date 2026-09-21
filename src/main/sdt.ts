import { clipboard, dialog, ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { SdtController } from './sdt-controller'
import { requestApi } from './sdt-api'
import { SdtStore, validateSteps } from './sdt-store'
import type { SdtApiResult, SdtReply, SdtRun, SdtState, SdtStep } from './sdt-types'
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
  private async reportHtml(run:SdtRun){
    const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
    const steps=new Map(this.store.list(run.site).flatMap(test=>test.steps).map(step=>[step.id,step]))
    const labels:Record<string,string>={passed:'Sikeres',failed:'Hibás',skipped:'Kihagyva',cancelled:'Megszakítva',running:'Folyamatban'}
    let rows='',diagnostics=''
    for(const [index,result] of run.results.entries()){
      const step=steps.get(result.id),expected=step?.expectedValue??(step?.kind?.startsWith('assert-')?step.value:'')??''
      rows+=`<tr><td>${index+1}</td><td><strong>${esc(result.name||step?.name||result.id)}</strong><small>${esc(step?.kind||'lépés')}</small></td><td><span class="status ${esc(result.status)}">${esc(labels[result.status]||result.status)}</span></td><td>${esc(expected||'—')}</td><td>${result.durationMs??0} ms</td><td>${esc(result.message||'—')}</td></tr>`
      let image='';if(result.screenshot)try{image=`<img alt="Hibakép" src="data:image/png;base64,${(await fs.promises.readFile(result.screenshot)).toString('base64')}">`}catch{}
      if(result.message||image||result.console?.length||result.network?.length)diagnostics+=`<details><summary>${index+1}. ${esc(result.name||step?.name||result.id)} diagnosztika</summary><dl><dt>Aktuális URL</dt><dd>${esc(result.currentUrl||'—')}</dd><dt>Lokátor</dt><dd><code>${esc(step?.selector||'—')}</code></dd></dl>${image}<h3>Konzol</h3><pre>${esc(result.console?.join('\n')||'Nincs konzolüzenet.')}</pre><h3>Hálózat</h3><pre>${esc((result.network??[]).map(item=>`${item.method} ${item.host}${item.path} ${item.status??item.error??''}`).join('\n')||'Nincs hálózati hiba.')}</pre></details>`
    }
    const date=new Date(run.startedAt).toLocaleString('hu-HU'),duration=(run.durationMs/1000).toFixed(2),status=run.status==='passed'?'Sikeres':run.status==='failed'?'Hibás':'Megszakítva'
    return `<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(run.name)} · SDT riport</title><style>:root{font-family:Inter,Segoe UI,sans-serif;color:#e9e9ed;background:#0b0b0d}*{box-sizing:border-box}body{max-width:1200px;margin:auto;padding:38px 24px;background:radial-gradient(circle at top right,#ff6a0018,transparent 35%)}header{display:flex;justify-content:space-between;gap:24px;align-items:start;border-bottom:1px solid #343238;padding-bottom:22px}h1{margin:4px 0;font-size:25px}.brand{color:#ff7a1a;font-weight:800;letter-spacing:.12em}.result{padding:8px 13px;border:1px solid #ff7a1a66;border-radius:99px;color:#ff9a54}.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:22px 0}.card{padding:14px;border:1px solid #302f34;border-radius:10px;background:#17171a}.card small{display:block;color:#8e929f;margin-bottom:5px}.card strong{font-size:17px}table{width:100%;border-collapse:collapse;background:#151518;border:1px solid #333138}th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #2d2c31;vertical-align:top}th{font-size:11px;color:#a4a6b0;background:#1e1d21}td{font-size:12px}td small{display:block;color:#777d89;margin-top:4px}.status{display:inline-block;padding:3px 8px;border-radius:99px;background:#333}.status.passed{color:#77d7a2;background:#163526}.status.failed{color:#ff9aaa;background:#401d25}.status.skipped{color:#d6b980;background:#3b321e}details{margin-top:12px;padding:13px;border:1px solid #343238;border-radius:9px;background:#151518}summary{cursor:pointer;font-weight:650;color:#ff9a54}dl{display:grid;grid-template-columns:120px 1fr;gap:7px;margin:14px 0}dt{color:#888e9b}dd{margin:0;word-break:break-all}pre{max-height:280px;overflow:auto;padding:12px;background:#0a0a0c;border-radius:7px;white-space:pre-wrap}img{display:block;max-width:100%;margin:15px 0;border:1px solid #444;border-radius:8px}@media print{body{background:#fff;color:#111;padding:10px}.card,table,details{background:#fff}.status{border:1px solid #777}details{break-inside:avoid}}@media(max-width:760px){.cards{grid-template-columns:1fr 1fr}table{display:block;overflow:auto}}</style></head><body><header><div><div class="brand">SKIPY DEVELOPER TOOLS</div><h1>${esc(run.name)}</h1><span>${esc(run.site)} · ${esc(date)}</span></div><div class="result">${status}</div></header><section class="cards"><div class="card"><small>Időtartam</small><strong>${duration} mp</strong></div><div class="card"><small>Összes lépés</small><strong>${run.results.length}</strong></div><div class="card"><small>Sikeres</small><strong>${run.passed}</strong></div><div class="card"><small>Hibás</small><strong>${run.failed}</strong></div><div class="card"><small>Kihagyva</small><strong>${run.skipped??0}</strong></div></section><h2>Lépések</h2><table><thead><tr><th>#</th><th>Lépés</th><th>Állapot</th><th>Elvárt érték</th><th>Idő</th><th>Eredmény</th></tr></thead><tbody>${rows}</tbody></table>${diagnostics?`<h2>Diagnosztika</h2>${diagnostics}`:''}</body></html>`
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
      else await fs.promises.writeFile(selected.filePath,await this.reportHtml(run),'utf8')
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
