import { app, BrowserWindow, ipcMain, session, shell, WebContentsView } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { resolveInput as resolveAddress } from './input'
import { getLibrary, id, loadLibrary, saveLibrary, validFavicon, type DownloadEntry } from './library'
import { clearRequests, flushPrivacy, hostForUrl, isBlocked, isFingerprintEnabled, loadPrivacy, recordRequest, requestSummary, secret, setFingerprintEnabled, siteForUrl, toggleBlock } from './privacy'

const TOOLBAR_HEIGHT = 94
const PANEL_WIDTH = 350
const HOME_URL = 'skipy://home'
app.setPath('userData', path.join(app.getPath('appData'), 'skipy-browser'))
type CertificateState = { status: 'none' | 'loading' | 'secure' | 'error' | 'unavailable'; host?: string; subject?: string; issuer?: string; validFrom?: number; validTo?: number; protocol?: string; cipher?: string; error?: string }
type Tab = { id: string; view: WebContentsView | null; title: string; url: string; favicon: string | null; loading: boolean; loadEpoch: number; audible: boolean; muted: boolean; bassDb: number; bassStatus: 'off' | 'starting' | 'active' | 'error'; audioView: WebContentsView | null; certificate: CertificateState; certCandidates: Map<string, CertificateState>; certReady: Promise<void> | null; error: string | null; site: string | null; protection: 'active' | 'error' | 'pending' }
const tabs: Tab[] = []
let activeId = ''
let globalBassDb = 0
let window: BrowserWindow
let nextId = 1
let panel: 'bookmarks' | 'history' | 'downloads' | 'settings' | 'privacy' | null = null
let panelView: WebContentsView | null = null
let downloadsView: WebContentsView | null = null
let panelAttached = false
let downloadsAttached = false
let panelRemoveTimer: ReturnType<typeof setTimeout> | null = null
let popupTimer: ReturnType<typeof setTimeout> | null = null
let downloadsOpen = false
let toolPopover: 'certificate' | 'bass' | null = null
let toolView: WebContentsView | null = null
let toolAttached = false
let toolAnchor = { x: 0, y: 0, width: 24, height: 24 }
const sessionDownloadIds = new Set<string>()
let downloadsButton = { x: 0, y: 0, width: 28, height: 29 }
let flightWindow: BrowserWindow | null = null
const recentClicks = new Map<number, { x: number; y: number; at: number }>()
let suggestionsInset = 0
let appFullscreen = false
let videoFullscreenTabId: string | null = null
let transitionView: WebContentsView | null = null
let transitionSurface: WebContentsView | null = null
let transitionTimer: ReturnType<typeof setTimeout> | null = null
let transitionListener: (() => void) | null = null
let transitionEntering = false
let noticeView: WebContentsView | null = null
let noticeAttached = false
let noticeTimer: ReturnType<typeof setTimeout> | null = null
let activeNoticeMessage = ''
const noticeQueue: { message: string; kind: 'success' | 'error' }[] = []
const runningDownloads = new Map<string, Electron.DownloadItem>()
let publishTimer: ReturnType<typeof setTimeout> | null = null

function publishSoon() {
  if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish() }, 150)
}

function publicState() {
  return {
    activeId,
    maximized: window?.isMaximized() ?? false,
    fullscreenMode: videoFullscreenTabId ? 'video' : appFullscreen ? 'app' : 'none',
    panel,
    downloadsOpen,
    toolPopover,
    globalBassDb,
    certificate: current()?.certificate ?? { status: 'none' },
    sessionDownloadIds: [...sessionDownloadIds],
    library: getLibrary(),
    privacy: current()?.site ? { ...requestSummary(current()!.site!), protection: current()!.protection } : null,
    tabs: tabs.map(({ id, title, url, favicon, loading, loadEpoch, audible, muted, bassDb, bassStatus, error, view }) => ({
      id, title, url, favicon, loading, loadEpoch, audible, muted, bassDb, bassStatus, error,
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
    })),
  }
}

function publish() {
  if (!window || window.isDestroyed()) return
  const state = publicState()
  window.webContents.send('browser:state', state)
  for (const view of [panelView, downloadsView, toolView]) if (view && !view.webContents.isDestroyed()) view.webContents.send('browser:state', state)
}

function current() { return tabs.find(tab => tab.id === activeId) }

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function dataPage(body: string, css: string) {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}</style></head><body>${body}</body></html>`)}`
}
function removeNotice() {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = null
  activeNoticeMessage = ''
  if (noticeView) {
    if (noticeAttached && window && !window.isDestroyed()) window.contentView.removeChildView(noticeView)
    if (!noticeView.webContents.isDestroyed()) noticeView.webContents.close()
    noticeView = null
    noticeAttached = false
  }
  showNextNotice()
}
function showNextNotice() {
  if (noticeView || transitionView || videoFullscreenTabId || !noticeQueue.length || !window || window.isDestroyed()) return
  const { message, kind } = noticeQueue.shift()!
  activeNoticeMessage = message
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  noticeView = view
  view.setBackgroundColor('#171719')
  const css = `*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;align-items:center;gap:12px;padding:0 19px;border:1px solid ${kind === 'error' ? '#9b4050' : '#8d4815'};border-radius:13px;background:#1c1b1d;color:#eee;font:600 13px Segoe UI,Arial,sans-serif;box-shadow:0 10px 30px #0007;animation:in .22s ease-out both}i{width:8px;height:32px;border-radius:8px;background:${kind === 'error' ? '#e45e71' : '#ff861f'};flex:none}span{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}@keyframes in{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){body{animation:none}}`
  void view.webContents.loadURL(dataPage(`<i></i><span>${escapeHtml(message)}</span>`, css)).then(() => {
    if (noticeView !== view || videoFullscreenTabId || !window || window.isDestroyed()) return
    window.contentView.addChildView(view)
    noticeAttached = true
    layout()
    noticeTimer = setTimeout(removeNotice, kind === 'error' ? 6000 : 3500)
  }).catch(() => { if (noticeView === view) removeNotice() })
}
function notice(message: string, kind: 'success' | 'error' = 'success') {
  if (noticeQueue.some(item => item.message === message) || activeNoticeMessage === message) return
  if (noticeQueue.length < 3) noticeQueue.push({ message: message.slice(0, 180), kind })
  showNextNotice()
}
function clearTransition(showNotices = true, keepView = false) {
  if (transitionTimer) clearTimeout(transitionTimer)
  transitionTimer = null
  if (transitionListener) {
    if (transitionEntering) window.removeListener('enter-full-screen', transitionListener)
    else window.removeListener('leave-full-screen', transitionListener)
  }
  transitionListener = null
  if (transitionView && !keepView) {
    if (window && !window.isDestroyed()) window.contentView.removeChildView(transitionView)
    if (!transitionView.webContents.isDestroyed()) void transitionView.webContents.executeJavaScript("document.body.style.transition='none'; document.body.classList.remove('reveal', 'zoom'); void document.body.offsetWidth; document.body.style.transition=''").catch(() => undefined)
    transitionView = null
  }
  if (showNotices) showNextNotice()
}
function transitionTo(fullscreen: boolean) {
  clearTransition(false, transitionView === transitionSurface)
  const view = transitionSurface
  if (!view || view.webContents.isDestroyed()) { window.setFullScreen(fullscreen); layout(); publish(); return }
  if (transitionView !== view) {
    transitionView = view
    window.contentView.addChildView(view)
  }
  layout()
  void view.webContents.executeJavaScript("document.body.style.transition='none'; document.body.classList.remove('reveal', 'zoom'); void document.body.offsetWidth; document.body.style.transition=''; document.body.classList.add('zoom')").catch(() => undefined)
  const alreadyThere = window.isFullScreen() === fullscreen
  const reveal = () => {
    if (transitionView !== view) return
    void view.webContents.executeJavaScript("document.body.classList.add('reveal')").catch(() => undefined)
    transitionTimer = setTimeout(() => { if (transitionView === view) clearTransition() }, 320)
  }
  const complete = () => {
    if (transitionView !== view) return
    layout(); publish()
    if (transitionTimer) clearTimeout(transitionTimer)
    transitionTimer = setTimeout(reveal, 130)
  }
  transitionEntering = fullscreen
  transitionListener = complete
  if (!alreadyThere) {
    if (fullscreen) window.once('enter-full-screen', complete)
    else window.once('leave-full-screen', complete)
    transitionTimer = setTimeout(reveal, 1400)
  }
  window.setFullScreen(fullscreen)
  if (alreadyThere) complete()
}

function layout() {
  if (!window || window.isDestroyed()) return
  const [width, height] = window.getContentSize()
  const full = appFullscreen || !!videoFullscreenTabId
  if (full) {
    if (panelView && panelAttached) { window.contentView.removeChildView(panelView); panelAttached = false }
    if (downloadsView && downloadsAttached) { window.contentView.removeChildView(downloadsView); downloadsAttached = false }
    if (toolView && toolAttached) { window.contentView.removeChildView(toolView); toolAttached = false }
  } else {
    if (panel && panelView && !panelAttached && !panelView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(panelView); panelAttached = true }
    if (downloadsOpen && downloadsView && !downloadsAttached && !downloadsView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(downloadsView); downloadsAttached = true }
    if (toolPopover && toolView && !toolAttached && !toolView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(toolView); toolAttached = true }
  }
  const top = full ? 0 : TOOLBAR_HEIGHT + suggestionsInset
  for (const tab of tabs) {
    if (tab.view && tab.id === activeId) {
      tab.view.setBounds({ x: 0, y: top, width: Math.max(0, width), height: Math.max(0, height - top) })
    }
  }
  if (transitionView) transitionView.setBounds({ x: 0, y: 0, width, height })
  if (panelView) panelView.setBounds({ x: Math.max(0, width - PANEL_WIDTH), y: TOOLBAR_HEIGHT, width: Math.min(PANEL_WIDTH, width), height: Math.max(0, height - TOOLBAR_HEIGHT) })
  if (downloadsView) downloadsView.setBounds({ x: Math.max(0, Math.min(width - 330, Math.round(downloadsButton.x + downloadsButton.width - 330))), y: 42, width: Math.min(330, width), height: Math.min(420, Math.max(0, height - 42)) })
  if (toolView) {
    const y = Math.max(42, Math.min(height - 150, Math.round(toolAnchor.y + toolAnchor.height + 6)))
    toolView.setBounds({ x: Math.max(0, Math.min(width - 340, Math.round(toolAnchor.x))), y, width: Math.min(340, width), height: Math.min(toolPopover === 'certificate' ? 350 : 190, Math.max(0, height - y - 8)) })
  }
  for (const tab of tabs) if (tab.audioView) tab.audioView.setBounds({ x: Math.max(0, width - 1), y: Math.max(0, height - 1), width: 1, height: 1 })
  if (noticeView) noticeView.setBounds({ x: Math.max(0, Math.floor((width - 420) / 2)), y: Math.max(0, height - 103), width: Math.min(420, width), height: 64 })
}

function overlayView(kind: 'panel' | 'downloads') {
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  view.setBackgroundColor('#00000000')
  view.webContents.on('did-finish-load', () => {
    if (kind === 'panel' ? !!panel : downloadsOpen) showOverlay(kind)
    publish()
  })
  void view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { overlay: kind } })
  return view
}

function showOverlay(kind: 'panel' | 'downloads') {
  const view = kind === 'panel' ? panelView : downloadsView
  if (!view || view.webContents.isDestroyed() || view.webContents.isLoadingMainFrame() || appFullscreen || videoFullscreenTabId) return
  if (kind === 'panel' && !panelAttached) { window.contentView.addChildView(view); panelAttached = true }
  if (kind === 'downloads' && !downloadsAttached) { window.contentView.addChildView(view); downloadsAttached = true }
  layout()
  publish()
}

function syncPanelOverlay() {
  if (panelRemoveTimer) clearTimeout(panelRemoveTimer)
  if (panel) {
    if (!panelView) panelView = overlayView('panel')
    showOverlay('panel')
  } else if (panelView && panelAttached) {
    panelView.webContents.send('browser:overlay-close')
    panelRemoveTimer = setTimeout(() => {
      if (!panel && panelView && panelAttached) { window.contentView.removeChildView(panelView); panelAttached = false }
    }, 260)
  }
}

function setDownloadsOpen(open: boolean) {
  downloadsOpen = open && sessionDownloadIds.size > 0
  if (popupTimer) clearTimeout(popupTimer)
  if (downloadsOpen) {
    if (!downloadsView) downloadsView = overlayView('downloads')
    showOverlay('downloads')
  } else if (downloadsView && downloadsAttached) {
    window.contentView.removeChildView(downloadsView)
    downloadsAttached = false
  }
  publish()
}

function setToolPopover(kind: 'certificate' | 'bass' | null, anchor?: { x: number; y: number; width: number; height: number }) {
  toolPopover = toolPopover === kind ? null : kind
  if (anchor) toolAnchor = anchor
  if (toolPopover) {
    if (!toolView) {
      toolView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
      toolView.setBackgroundColor('#00000000')
      toolView.webContents.on('did-finish-load', () => { layout(); publish() })
      void toolView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { overlay: 'tool' } })
    }
  } else if (toolView && toolAttached) {
    window.contentView.removeChildView(toolView)
    toolAttached = false
  }
  layout(); publish()
}

function scheduleDownloadsClose() {
  if (popupTimer) clearTimeout(popupTimer)
  if (getLibrary().downloads.some(entry => sessionDownloadIds.has(entry.id) && entry.status === 'progressing')) return
  popupTimer = setTimeout(() => setDownloadsOpen(false), 3500)
}

const flightHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
.fly-file{position:fixed;width:38px;height:46px;border:2px solid #ff6600;border-radius:7px;background:#281708;box-shadow:0 0 20px #ff6600aa;display:grid;place-items:center;color:#ff8b32;font:700 22px Segoe UI,Arial,sans-serif;pointer-events:none;will-change:transform,opacity}
.particle{position:fixed;width:5px;height:5px;border-radius:50%;background:#ff7b16;box-shadow:0 0 8px #ff6600;pointer-events:none}
</style></head><body><script>
window.fly=function(sx,sy,tx,ty){
 const file=document.createElement('div');file.className='fly-file';file.textContent='↓';document.body.append(file);
 if(matchMedia('(prefers-reduced-motion: reduce)').matches){file.remove();return}
 const start=performance.now(),duration=680,dx=tx-sx,dy=ty-sy;
 function tick(now){const t=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-t,3);
 const x=sx+dx*ease,y=sy+dy*ease-Math.sin(Math.PI*ease)*Math.min(120,Math.abs(dx)*.22+50);
 file.style.transform='translate('+(x-19)+'px,'+(y-23)+'px) scale('+(1-.8*ease)+') rotate('+(15*ease)+'deg)';file.style.opacity=String(1-.75*ease);
 if(t<1){if(Math.random()<.55){const p=document.createElement('i');p.className='particle';p.style.left=x+'px';p.style.top=y+'px';document.body.append(p);p.animate([{opacity:.7,transform:'scale(1)'},{opacity:0,transform:'translateY(14px) scale(.1)'}],{duration:320,fill:'forwards'}).onfinish=()=>p.remove()}requestAnimationFrame(tick)}else file.remove()
 }requestAnimationFrame(tick)
}
</script></body></html>`
let flightReady: Promise<void> | null = null
let flightsInProgress = 0
function flyDownload(start: { x: number; y: number }) {
  if (!window || window.isDestroyed()) return
  if (!flightWindow || flightWindow.isDestroyed()) {
    flightWindow = new BrowserWindow({ parent: window, frame: false, transparent: true, focusable: false, show: false, skipTaskbar: true, backgroundColor: '#00000000', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    flightWindow.setIgnoreMouseEvents(true, { forward: true })
    flightReady = flightWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(flightHtml)}`)
  }
  const target = { x: downloadsButton.x + downloadsButton.width / 2, y: downloadsButton.y + downloadsButton.height / 2 }
  const effect = flightWindow
  flightsInProgress++
  void flightReady?.then(() => {
    if (effect.isDestroyed()) return
    effect.setBounds(window.getBounds())
    effect.showInactive()
    return effect.webContents.executeJavaScript(`window.fly(${Math.round(start.x)},${Math.round(start.y)},${Math.round(target.x)},${Math.round(target.y)})`)
  }).catch(() => undefined)
  setTimeout(() => {
    if (!window.isDestroyed()) window.webContents.send('browser:download-land')
    flightsInProgress--
    if (flightsInProgress === 0 && !effect.isDestroyed()) effect.hide()
  }, 730)
}

function showTab(id: string) {
  const next = tabs.find(tab => tab.id === id)
  if (!next) return
  const previous = current()
  if (previous?.view) window.contentView.removeChildView(previous.view)
  activeId = id
  if (toolPopover) { toolPopover = null; if (toolView && toolAttached) { window.contentView.removeChildView(toolView); toolAttached = false } }
  if (next.view) window.contentView.addChildView(next.view)
  for (const [overlay, attached] of [[panelView, panelAttached], [downloadsView, downloadsAttached], [toolView, toolAttached]] as const) if (overlay && attached) { window.contentView.removeChildView(overlay); window.contentView.addChildView(overlay) }
  layout()
  publish()
}

function configuredHome() { return getLibrary().settings.homepage === 'skipy' ? HOME_URL : getLibrary().settings.homepage }

function fingerprintSeed(site: string) { return createHmac('sha256', secret()).update(site).digest().readUInt32BE(0) }

function loadPage(tab: Tab, url: string) {
  if (!tab.view || tab.view.webContents.isDestroyed()) return
  tab.protection = 'pending'
  const view = tab.view
  void (async () => {
    await Promise.race([tab.certReady ?? Promise.resolve(), new Promise<void>(resolve => setTimeout(resolve, 1500))])
    if (tab.view === view && !view.webContents.isDestroyed()) await view.webContents.loadURL(url).catch(() => undefined)
  })()
}

function monitorRequests() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const tab = tabs.find(item => item.view?.webContents.id === details.webContentsId)
    const host = hostForUrl(details.url)
    if (!tab || !host) { callback({}); return }
    if (details.resourceType === 'mainFrame') tab.site = siteForUrl(details.url)
    const site = tab.site
    if (!site) { callback({}); return }
    const blocked = isBlocked(site, host)
    recordRequest(site, host, blocked)
    if (tab.id === activeId) publishSoon()
    callback({ cancel: blocked })
  })
}

function resolveInput(input: string): string {
  return resolveAddress(input, getLibrary().settings.searchEngine)
}

function certificateKey(url: string) {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.toString() } catch { return url }
}
function certificateForUrl(url: string): CertificateState {
  if (!/^https:\/\//i.test(url)) return { status: 'none' }
  return { status: 'loading', host: new URL(url).host }
}
function monitorCertificate(tab: Tab, wc: Electron.WebContents) {
  const debuggerApi = wc.debugger
  debuggerApi.on('message', (_event, method, params) => {
    if (method !== 'Network.responseReceived' || params?.type !== 'Document') return
    const response = params.response
    if (!response || typeof response.url !== 'string' || !/^https:\/\//i.test(response.url)) return
    const details = response.securityDetails
    const candidate: CertificateState = details && response.securityState === 'secure'
      ? { status: 'secure', host: new URL(response.url).host, subject: details.subjectName, issuer: details.issuer, validFrom: details.validFrom, validTo: details.validTo, protocol: details.protocol, cipher: details.cipher }
      : { status: 'unavailable', host: new URL(response.url).host }
    const key = certificateKey(response.url)
    tab.certCandidates.set(key, candidate)
    if (tab.certCandidates.size > 8) tab.certCandidates.delete(tab.certCandidates.keys().next().value!)
    if (certificateKey(tab.url) === key || certificateKey(wc.getURL()) === key) { tab.certificate = candidate; publish() }
  })
  debuggerApi.on('detach', () => {
    if (/^https:\/\//i.test(tab.url) && tab.certificate.status !== 'error') { tab.certificate = { status: 'unavailable', host: new URL(tab.url).host }; publish() }
  })
  tab.certReady = (async () => {
    try { debuggerApi.attach('1.3'); await debuggerApi.sendCommand('Network.enable') }
    catch { tab.certificate = /^https:\/\//i.test(tab.url) ? { status: 'unavailable', host: new URL(tab.url).host } : { status: 'none' }; publish() }
  })()
}

function stopBass(tab: Tab, resetLevel: boolean) {
  const audioView = tab.audioView
  tab.audioView = null
  if (audioView && !audioView.webContents.isDestroyed()) {
    audioView.webContents.send('audio:stop')
    if (window && !window.isDestroyed()) window.contentView.removeChildView(audioView)
    audioView.webContents.close()
  }
  if (resetLevel) tab.bassDb = 0
  tab.bassStatus = 'off'
  if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(tab.muted)
}

function startBass(tab: Tab) {
  if (tab.bassDb <= 0 || !tab.view || tab.view.webContents.isDestroyed() || tab.audioView) return
  const source = tab.view.webContents
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'audio-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  tab.audioView = view
  tab.bassStatus = 'starting'
  view.setBackgroundColor('#00000000')
  window.contentView.addChildView(view)
  layout()
  view.webContents.on('did-finish-load', () => {
    if (tab.audioView !== view || source.isDestroyed()) return
    try {
      view.webContents.send('audio:start', tab.bassDb, tab.muted)
    } catch (error) {
      stopBass(tab, true)
      tab.bassStatus = 'error'
      notice(error instanceof Error ? `Bass Booster: ${error.message}` : 'Bass Booster: a hangrögzítés nem sikerült.', 'error')
      publish()
    }
  })
  void view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'audio.html')).catch(error => {
    if (tab.audioView === view) { stopBass(tab, true); tab.bassStatus = 'error'; notice(`Bass Booster: ${String(error)}`, 'error'); publish() }
  })
  publish()
}

function setBass(tab: Tab, db: number) {
  tab.bassDb = db
  if (db === 0) stopBass(tab, true)
  else if (tab.audioView && !tab.audioView.webContents.isDestroyed()) tab.audioView.webContents.send('audio:update', db, tab.muted)
  else startBass(tab)
  publish()
}

function setGlobalBass(db: number) {
  globalBassDb = db
  for (const tab of tabs) setBass(tab, db)
  publish()
}

function attachPage(tab: Tab) {
  const view = new WebContentsView({ webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
    disableHtmlFullscreenWindowResize: true,
    preload: path.join(__dirname, 'fingerprint-preload.js'),
  } })
  tab.view = view
  const wc = view.webContents
  monitorCertificate(tab, wc)
  wc.on('input-event', (_event, input) => {
    if (input.type === 'mouseUp' && 'x' in input && 'y' in input && typeof input.x === 'number' && typeof input.y === 'number') recentClicks.set(wc.id, { x: input.x, y: input.y, at: Date.now() })
  })
  wc.on('audio-state-changed', event => { tab.audible = event.audible; publish() })
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) setImmediate(() => createTab(url))
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault()
  })
  wc.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) {
      tab.favicon = null; tab.site = siteForUrl(details.url)
      tab.certCandidates.clear(); tab.certificate = certificateForUrl(details.url)
      if (tab.audioView) stopBass(tab, false)
      publish()
    }
  })
  wc.on('did-start-loading', () => { tab.loading = true; tab.loadEpoch++; tab.error = null; publish() })
  wc.on('did-stop-loading', () => { tab.loading = false; publish() })
  wc.on('did-navigate', (_event, url) => { tab.url = url; tab.site = siteForUrl(url); tab.certificate = tab.certCandidates.get(certificateKey(url)) ?? certificateForUrl(url); publish() })
  wc.on('did-navigate-in-page', (_event, url) => { tab.url = url; publish() })
  wc.on('did-finish-load', () => {
    if (tab.certificate.status === 'loading') { tab.certificate = { status: 'unavailable', host: /^https:\/\//i.test(wc.getURL()) ? new URL(wc.getURL()).host : undefined }; publish() }
    if (tab.bassDb > 0 && !tab.audioView && !tab.error) startBass(tab)
    if (tab.protection === 'pending') setTimeout(() => { if (tab.protection === 'pending') { tab.protection = 'error'; publish() } }, 150)
    if (tab.error || !/^https?:\/\//i.test(wc.getURL())) return
    const url = wc.getURL()
    const title = wc.getTitle() || url
    tab.url = url
    const history = getLibrary().history
    history.unshift({ id: id(), title, url, visitedAt: Date.now(), ...(tab.favicon ? { favicon: tab.favicon } : {}) })
    if (history.length > 1000) history.length = 1000
    saveLibrary()
    publish()
  })
  wc.on('page-title-updated', (_event, title) => { tab.title = title || 'Új lap'; publish() })
  wc.on('page-favicon-updated', (_event, favicons) => {
    const icon = favicons.find(validFavicon)
    if (!icon || !/^https?:\/\//i.test(wc.getURL())) return
    tab.favicon = icon
    let changed = false
    for (const entry of [...getLibrary().bookmarks, ...getLibrary().history]) {
      if (entry.url === wc.getURL() && entry.favicon !== icon) { entry.favicon = icon; changed = true }
    }
    if (changed) saveLibrary()
    publish()
  })
  wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) { tab.error = `Az oldal nem tölthető be: ${description}`; tab.url = url; if (tab.certificate.status === 'loading') tab.certificate = { status: 'unavailable', host: /^https:\/\//i.test(url) ? new URL(url).host : undefined }; if (tab.protection === 'pending') tab.protection = 'error'; if (tab.id === activeId) notice(tab.error, 'error'); publish() }
  })
  wc.on('certificate-error', (_event, url, error, _certificate, _callback, isMainFrame) => {
    if (isMainFrame) { tab.certificate = { status: 'error', host: /^https:\/\//i.test(url) ? new URL(url).host : undefined, error }; publish() }
  })
  wc.on('before-input-event', (event, input) => handleShortcut(input, event))
  wc.on('enter-html-full-screen', () => {
    if (tab.id !== activeId) return
    videoFullscreenTabId = tab.id
    if (noticeView) removeNotice()
    transitionTo(true)
    layout(); publish()
  })
  wc.on('leave-html-full-screen', () => {
    if (videoFullscreenTabId !== tab.id) return
    videoFullscreenTabId = null
    transitionTo(appFullscreen)
    layout(); publish()
  })
}

function createTab(input = configuredHome()) {
  const tab: Tab = { id: String(nextId++), view: null, title: 'Új lap', url: input === HOME_URL ? HOME_URL : resolveInput(input), favicon: null, loading: false, loadEpoch: 0, audible: false, muted: false, bassDb: globalBassDb, bassStatus: 'off', audioView: null, certificate: certificateForUrl(input === HOME_URL ? HOME_URL : resolveInput(input)), certCandidates: new Map(), certReady: null, error: null, site: input === HOME_URL ? null : siteForUrl(resolveInput(input)), protection: 'pending' }
  tabs.push(tab)
  if (input !== HOME_URL) {
    attachPage(tab)
    void loadPage(tab, resolveInput(input))
  }
  showTab(tab.id)
  return tab
}

function navigate(input: string) {
  const tab = current()
  if (!tab) return
  const url = resolveInput(input)
  tab.error = null
  if (url === HOME_URL) {
    stopBass(tab, false)
    if (tab.view) {
      window.contentView.removeChildView(tab.view)
      tab.view.webContents.close()
      tab.view = null
    }
    tab.title = 'Új lap'; tab.url = HOME_URL; tab.favicon = null; tab.loading = false; tab.audible = false; tab.muted = false; tab.site = null; tab.protection = 'pending'
    publish()
    return
  }
  if (!tab.view) { attachPage(tab); window.contentView.addChildView(tab.view!); layout() }
  tab.url = url
  tab.site = siteForUrl(url)
  tab.favicon = null
  publish()
  void loadPage(tab, url)
}

function closeTab(id: string) {
  const index = tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  const [tab] = tabs.splice(index, 1)
  stopBass(tab, true)
  if (tab.view) {
    if (id === activeId) window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  if (!tabs.length) { activeId = ''; createTab(); return }
  if (id === activeId) { activeId = ''; showTab(tabs[Math.min(index, tabs.length - 1)].id) }
  else publish()
}

function handleShortcut(input: Electron.Input, event?: { preventDefault(): void }) {
  if (input.type !== 'keyDown') return
  const ctrl = input.control || input.meta
  const key = input.key.toLowerCase()
  if (key === 'f11') {
    if (videoFullscreenTabId) return
    event?.preventDefault()
    appFullscreen = !appFullscreen
    window.setFullScreen(appFullscreen)
    layout(); publish()
  }
  else if (key === 'escape' && appFullscreen && !videoFullscreenTabId) {
    event?.preventDefault()
    appFullscreen = false
    window.setFullScreen(false)
    layout(); publish()
  }
  else if (videoFullscreenTabId) return
  else if (ctrl && key === 'l') window.webContents.send('browser:focus-address')
  else if (ctrl && key === 't') { createTab(); window.webContents.send('browser:focus-address') }
  else if (ctrl && key === 'w') closeTab(activeId)
  else if (input.alt && key === 'left') current()?.view?.webContents.navigationHistory.goBack()
  else if (input.alt && key === 'right') current()?.view?.webContents.navigationHistory.goForward()
  else if (ctrl && key === 'r') current()?.view?.webContents.reload()
}

function toggleBookmark() {
  const tab = current()
  if (!tab || !/^https?:\/\//i.test(tab.url)) return
  const bookmarks = getLibrary().bookmarks
  const index = bookmarks.findIndex(item => item.url === tab.url)
  if (index >= 0) { bookmarks.splice(index, 1); notice('Könyvjelző eltávolítva.') }
  else { bookmarks.unshift({ id: id(), title: tab.title || tab.url, url: tab.url, createdAt: Date.now(), ...(tab.favicon ? { favicon: tab.favicon } : {}) }); notice('Könyvjelző hozzáadva.') }
  saveLibrary(); publish()
}

function uniqueDownloadPath(filename: string): string {
  const directory = app.getPath('downloads')
  fs.mkdirSync(directory, { recursive: true })
  const safeName = path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'letoltes'
  const parsed = path.parse(safeName)
  let candidate = path.join(directory, safeName)
  let suffix = 1
  const inUse = () => fs.existsSync(candidate) || getLibrary().downloads.some(entry => entry.path === candidate && entry.status === 'progressing')
  while (inUse()) candidate = path.join(directory, `${parsed.name} (${suffix++})${parsed.ext}`)
  return candidate
}

function trackDownloads() {
  session.defaultSession.on('will-download', (_event, item, contents) => {
    const savePath = uniqueDownloadPath(item.getFilename())
    item.setSavePath(savePath)
    const entry: DownloadEntry = { id: id(), name: path.basename(savePath), path: savePath, url: item.getURL(), received: 0, total: item.getTotalBytes(), status: 'progressing', startedAt: Date.now() }
    getLibrary().downloads.unshift(entry)
    sessionDownloadIds.add(entry.id)
    runningDownloads.set(entry.id, item)
    setDownloadsOpen(true)
    const sourceTab = tabs.find(tab => tab.view?.webContents.id === contents?.id)
    const click = contents && recentClicks.get(contents.id)
    const [width, height] = window.getContentSize()
    const start = sourceTab && click && Date.now() - click.at < 1800
      ? { x: click.x + sourceTab.view!.getBounds().x, y: click.y + sourceTab.view!.getBounds().y }
      : { x: width / 2, y: (height + TOOLBAR_HEIGHT) / 2 }
    flyDownload(start)
    saveLibrary(); publish()
    item.on('updated', (_event, status) => {
      entry.received = item.getReceivedBytes()
      entry.total = item.getTotalBytes()
      if (status === 'interrupted') entry.status = 'interrupted'
      publish()
    })
    item.on('done', (_event, status) => {
      entry.received = item.getReceivedBytes()
      entry.total = item.getTotalBytes()
      entry.status = status
      notice(status === 'completed' ? `Letöltve: ${entry.name}` : `A letöltés ${status === 'cancelled' ? 'megszakadt' : 'nem sikerült'}.`, status === 'completed' ? 'success' : 'error')
      runningDownloads.delete(entry.id)
      scheduleDownloadsClose()
      saveLibrary(); publish()
    })
  })
}

app.whenReady().then(() => {
  loadLibrary()
  loadPrivacy()
  ipcMain.on('privacy:fingerprint-config', event => {
    const tab = tabs.find(item => item.view?.webContents.id === event.sender.id)
    const site = tab?.site || siteForUrl(event.sender.getURL())
    event.returnValue = site ? { seed: fingerprintSeed(site), enabled: isFingerprintEnabled(site) } : null
  })
  ipcMain.on('privacy:fingerprint-status', (event, success: unknown) => {
    const tab = tabs.find(item => item.view?.webContents.id === event.sender.id)
    if (tab && event.senderFrame === event.sender.mainFrame) { tab.protection = success === true ? 'active' : 'error'; publish() }
  })
  monitorRequests()
  trackDownloads()
  ipcMain.on('audio:status', (event, kind: unknown, message: unknown) => {
    const tab = tabs.find(item => item.audioView?.webContents === event.sender)
    if (!tab) return
    if (kind === 'active' && tab.view && !tab.view.webContents.isDestroyed()) {
      tab.bassStatus = 'active'
      tab.view.webContents.setAudioMuted(false)
      tab.audioView?.webContents.send('audio:update', tab.bassDb, tab.muted)
    } else if (kind === 'error') {
      stopBass(tab, true)
      tab.bassStatus = 'error'
      notice(`Bass Booster: ${typeof message === 'string' ? message.slice(0, 120) : 'a hangrögzítés megszakadt.'}`, 'error')
    }
    publish()
  })
  const isBrowserTab = (contents: Electron.WebContents | null) => !!contents && tabs.some(tab => tab.view?.webContents.id === contents.id)
  const isAudioProcessor = (contents: Electron.WebContents | null) => !!contents && tabs.some(tab => tab.audioView?.webContents.id === contents.id)
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const tab = tabs.find(item => item.audioView?.webContents.mainFrame === request.frame)
    const source = tab?.view?.webContents.mainFrame
    if (!request.frame || !tab || !source || !request.audioRequested || !request.videoRequested) { callback({}); return }
    callback({ video: source, audio: source, enableLocalEcho: false })
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'fullscreen' && isBrowserTab(contents) || (permission === 'display-capture' || permission === 'media') && isAudioProcessor(contents)))
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'fullscreen' && isBrowserTab(contents) || (permission === 'display-capture' || permission === 'media') && isAudioProcessor(contents))
  window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 680, minHeight: 400,
    title: 'Skipy Browser', backgroundColor: '#111113', frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  transitionSurface = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  transitionSurface.setBackgroundColor('#00000000')
  const transitionCss = `html{margin:0;width:100%;height:100%;background:transparent}body{margin:0;width:100%;height:100%;background:#080809;overflow:hidden;opacity:1;transition:opacity .28s cubic-bezier(.22,1,.36,1)}body.reveal{opacity:0}body:after{content:"";position:absolute;left:50%;top:50%;width:42vmax;height:42vmax;border-radius:50%;background:radial-gradient(circle,#17100c 0,#0b0908 35%,#080809 72%);transform:translate(-50%,-50%) scale(.7);opacity:.55}body.zoom:after{animation:zoom .42s cubic-bezier(.22,1,.36,1) both}@keyframes zoom{to{transform:translate(-50%,-50%) scale(1.45);opacity:.16}}@media(prefers-reduced-motion:reduce){body,body.zoom:after{transition:none;animation:none}}`
  void transitionSurface.webContents.loadURL(dataPage('', transitionCss)).catch(() => undefined)
  window.on('closed', () => {
    for (const tab of tabs) stopBass(tab, true)
    if (transitionSurface && !transitionSurface.webContents.isDestroyed()) transitionSurface.webContents.close()
    transitionSurface = null
  })
  window.on('resize', layout)
  window.on('move', () => { if (flightWindow && !flightWindow.isDestroyed()) flightWindow.setBounds(window.getBounds()) })
  window.on('enter-full-screen', () => { layout(); publish() })
  window.on('leave-full-screen', () => { if (!videoFullscreenTabId) appFullscreen = false; layout(); publish() })
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.webContents.on('before-input-event', (event, input) => handleShortcut(input, event))
  window.webContents.on('did-finish-load', publish)
  void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  createTab()

  ipcMain.handle('browser:command', (event, action: unknown, value: unknown) => {
    if (event.sender !== window.webContents && event.sender !== panelView?.webContents && event.sender !== downloadsView?.webContents && event.sender !== toolView?.webContents || typeof action !== 'string') return
    const text = typeof value === 'string' ? value : ''
    if (action === 'state') return publicState()
    if (action === 'notice-error') { if (text.length <= 180) notice(text, 'error'); return }
    if (action === 'window-minimize') window.minimize()
    else if (action === 'window-maximize') {
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    }
    else if (action === 'window-close') window.close()
    else if (action === 'new') createTab()
    else if (action === 'select') showTab(text)
    else if (action === 'close') closeTab(text)
    else if (action === 'suggestion-inset') {
      const inset = Number(text)
      if (Number.isInteger(inset) && inset >= 0 && inset <= 400 && inset !== suggestionsInset) { suggestionsInset = inset; layout() }
      return
    }
    else if (action === 'toggle-mute') {
      const tab = tabs.find(item => item.id === text)
      if (tab?.view && !tab.view.webContents.isDestroyed()) {
        tab.muted = !tab.muted
        if (tab.audioView && !tab.audioView.webContents.isDestroyed()) tab.audioView.webContents.send('audio:update', tab.bassDb, tab.muted)
        else tab.view.webContents.setAudioMuted(tab.muted)
      }
    }
    else if (action === 'bass-set') {
      const db = Number(text)
      if (text.trim() !== '' && Number.isInteger(db) && db >= 0 && db <= 12) setGlobalBass(db)
    }
    else if (action === 'tool') {
      if (event.sender !== window.webContents) return
      try {
        const request = JSON.parse(text) as { kind: 'certificate' | 'bass'; anchor: { x: number; y: number; width: number; height: number } }
        if ((request.kind === 'certificate' || request.kind === 'bass') && request.anchor && ['x', 'y', 'width', 'height'].every(key => typeof request.anchor[key as keyof typeof request.anchor] === 'number' && Number.isFinite(request.anchor[key as keyof typeof request.anchor]))) setToolPopover(request.kind, request.anchor)
      } catch { /* Ignore invalid controls. */ }
      return
    }
    else if (action === 'tool-close') { setToolPopover(null); return }
    else if (action === 'navigate') navigate(text)
    else if (action === 'home') navigate(configuredHome() === HOME_URL ? '' : configuredHome())
    else if (action === 'back') current()?.view?.webContents.navigationHistory.goBack()
    else if (action === 'forward') current()?.view?.webContents.navigationHistory.goForward()
    else if (action === 'reload') current()?.view?.webContents.reload()
    else if (action === 'panel') {
      if (text === 'bookmarks' || text === 'history' || text === 'settings' || text === 'privacy') panel = panel === text ? null : text
      else if (text === 'close') panel = null
      syncPanelOverlay()
      layout()
    }
    else if (action === 'downloads-toggle') setDownloadsOpen(!downloadsOpen)
    else if (action === 'downloads-close') setDownloadsOpen(false)
    else if (action === 'downloads-button-bounds') {
      try {
        const bounds = JSON.parse(text)
        if (['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]))) {
          downloadsButton = bounds
          layout()
        }
      } catch { /* Ignore malformed geometry. */ }
      return
    }
    else if (action === 'bookmark-toggle') toggleBookmark()
    else if (action === 'quicklink-save') {
      let draft: { id?: unknown; title?: unknown; url?: unknown }
      try { draft = JSON.parse(text) } catch { return 'Érvénytelen gyors elérés.' }
      const title = typeof draft.title === 'string' ? draft.title.trim() : ''
      const url = typeof draft.url === 'string' ? draft.url.trim() : ''
      if (!title || title.length > 60 || !validFavicon(url)) return 'Adj meg egy nevet és egy teljes HTTP(S) webcímet.'
      const links = getLibrary().quickLinks
      const existing = typeof draft.id === 'string' ? links.find(item => item.id === draft.id) : undefined
      if (draft.id && !existing) return 'A gyors elérés nem található.'
      if (existing) { existing.title = title; existing.url = url }
      else {
        if (links.length >= 6) return 'Legfeljebb hat gyors elérés adható hozzá.'
        links.push({ id: id(), title, url })
      }
      saveLibrary()
      notice(existing ? 'Gyors elérés módosítva.' : 'Gyors elérés hozzáadva.')
    }
    else if (action === 'quicklink-remove') {
      const links = getLibrary().quickLinks
      const index = links.findIndex(item => item.id === text)
      if (index >= 0) { links.splice(index, 1); saveLibrary(); notice('Gyors elérés törölve.') }
    }
    else if (action === 'quicklink-open') {
      const link = getLibrary().quickLinks.find(item => item.id === text)
      if (link) navigate(link.url)
    }
    else if (action === 'bookmark-remove') {
      const items = getLibrary().bookmarks
      const index = items.findIndex(item => item.id === text)
      if (index >= 0) { items.splice(index, 1); saveLibrary(); notice('Könyvjelző törölve.') }
    }
    else if (action === 'history-remove') {
      const items = getLibrary().history
      const index = items.findIndex(item => item.id === text)
      if (index >= 0) { items.splice(index, 1); saveLibrary(); notice('Előzmény törölve.') }
    }
    else if (action === 'history-clear') { getLibrary().history.length = 0; saveLibrary(); notice('Előzmények törölve.') }
    else if (action === 'open-entry') {
      const entry = [...getLibrary().bookmarks, ...getLibrary().history].find(item => item.id === text)
      if (entry) navigate(entry.url)
    }
    else if (action === 'download-cancel') runningDownloads.get(text)?.cancel()
    else if (action === 'download-reveal') {
      const entry = getLibrary().downloads.find(item => item.id === text && item.status === 'completed')
      if (entry && fs.existsSync(entry.path)) shell.showItemInFolder(entry.path)
    }
    else if (action === 'download-remove') {
      const items = getLibrary().downloads
      const index = items.findIndex(item => item.id === text && item.status !== 'progressing')
      if (index >= 0) { items.splice(index, 1); sessionDownloadIds.delete(text); if (!sessionDownloadIds.size) setDownloadsOpen(false); saveLibrary(); notice('Letöltés bejegyzése törölve.') }
    }
    else if (action === 'settings-search') {
      if (!['google', 'duckduckgo', 'bing'].includes(text)) return 'Ismeretlen kereső.'
      getLibrary().settings.searchEngine = text as 'google' | 'duckduckgo' | 'bing'
      saveLibrary()
      notice('Kereső beállítva.')
    }
    else if (action === 'settings-home') {
      const value = text.trim()
      if (value !== 'skipy' && !validFavicon(value)) return 'Adj meg egy teljes http:// vagy https:// webcímet.'
      getLibrary().settings.homepage = value
      saveLibrary()
      notice('Kezdőlap beállítva.')
    }
    else if (action === 'privacy-block') {
      const site = current()?.site
      if (site && hostForUrl(`https://${text}/`) === text) { toggleBlock(site, text); notice('Webhelyszabály módosítva.') }
    }
    else if (action === 'privacy-clear-site') { if (current()?.site) { clearRequests(current()!.site!); notice('A webhely kérései törölve.') } }
    else if (action === 'privacy-clear-all') { clearRequests(); notice('A kérésnaplók törölve.') }
    else if (action === 'privacy-fingerprint') {
      const site = current()?.site
      if (site && (text === 'on' || text === 'off')) {
        setFingerprintEnabled(site, text === 'on')
        for (const tab of tabs) if (tab.site === site) tab.view?.webContents.reload()
        notice(text === 'on' ? 'Ujjlenyomat-védelem bekapcsolva.' : 'Ujjlenyomat-védelem kikapcsolva.')
      }
    }
    publish()
  })
})

app.on('before-quit', flushPrivacy)
app.on('window-all-closed', () => app.quit())
