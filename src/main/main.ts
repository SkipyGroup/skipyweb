import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, session, shell, WebContentsView, type MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import extract from 'extract-zip'
import { resolveInput as resolveAddress } from './input'
import { flushLibrary, getLibrary, id, loadLibrary, saveLibrary, validFavicon, type DownloadEntry } from './library'
import { clearRequests, flushPrivacy, hostForUrl, isBlocked, isFingerprintEnabled, loadPrivacy, recordRequest, requestSummary, secret, setFingerprintEnabled, siteForUrl, toggleBlock } from './privacy'
import { adblockEnabled, clearOnExit, cosmeticCss, flushSwp, isAdRequest, loadSwp, permissionFor, popupFor, recordAdBlocked, recordPopupBlocked, setPermission, setPopup, swpData, toggleAdblock, toggleClearOnExit, updateLists, type SwpPermission } from './swp'
import { SdtService } from './sdt'

const TOOLBAR_HEIGHT = 94
const PANEL_WIDTH = 350
const HOME_URL = 'skipy://home'
const privateMode = process.argv.includes('--skipy-private')
const windowArgument = process.argv.find(argument => argument.startsWith('--skipy-window='))
const windowToken = windowArgument?.slice('--skipy-window='.length).replace(/[^a-zA-Z0-9_-]/g, '') || ''
const privateRoot = privateMode ? path.join(app.getPath('temp'), `skipy-private-${windowToken || process.pid}`) : ''
const userDataPath = privateMode ? path.join(privateRoot, 'profile') : path.join(app.getPath('appData'), 'skipy-browser')
const localDataRoot = process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local')
let sessionDataPath = privateMode
  ? path.join(privateRoot, 'session')
  : windowToken
    ? path.join(localDataRoot, 'skipy-browser', `session-${windowToken}`)
    : path.join(localDataRoot, 'skipy-browser', 'session')
try { fs.mkdirSync(sessionDataPath, { recursive: true }) }
catch {
  sessionDataPath = path.join(app.getPath('temp'), 'skipy-browser-session')
  fs.mkdirSync(sessionDataPath, { recursive: true })
}
app.setPath('userData', userDataPath)
app.setPath('sessionData', sessionDataPath)
app.commandLine.appendSwitch('disk-cache-dir', path.join(sessionDataPath, 'Cache'))
const hasSingleInstanceLock = windowToken ? true : app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
let pendingExternalUrl = process.argv.find(argument => /^https?:\/\//i.test(argument)) || ''
type CertificateState = { status: 'none' | 'loading' | 'secure' | 'error' | 'unavailable'; host?: string; subject?: string; issuer?: string; validFrom?: number; validTo?: number; protocol?: string; cipher?: string; error?: string }
type Tab = { id: string; view: WebContentsView | null; title: string; url: string; favicon: string | null; loading: boolean; loadEpoch: number; audible: boolean; muted: boolean; bassDb: number; bassStatus: 'off' | 'starting' | 'active' | 'error'; audioView: WebContentsView | null; certificate: CertificateState; certCandidates: Map<string, CertificateState>; certReady: Promise<void> | null; error: string | null; site: string | null; protection: 'active' | 'error' | 'pending'; closing: boolean; hibernated: boolean; lastActiveAt: number }
const tabs: Tab[] = []
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
let activeId = ''
let globalBassDb = 0
let globalBassFrequency = 95
let window: BrowserWindow
let sdt: SdtService | null = null
let nextId = 1
let panel: 'bookmarks' | 'history' | 'downloads' | 'settings' | 'privacy' | 'extensions' | null = null
let panelView: WebContentsView | null = null
let downloadsView: WebContentsView | null = null
let downloadConfirmView: WebContentsView | null = null
let jsDialogView: WebContentsView | null = null
let swpPromptView: WebContentsView | null = null
let panelAttached = false
let downloadsAttached = false
let downloadConfirmAttached = false
let jsDialogAttached = false
let swpPromptAttached = false
let panelRemoveTimer: ReturnType<typeof setTimeout> | null = null
let popupTimer: ReturnType<typeof setTimeout> | null = null
let downloadsOpen = false
let toolPopover: 'certificate' | 'bass' | null = null
let toolView: WebContentsView | null = null
let toolAttached = false
let toolAnchor = { x: 0, y: 0, width: 24, height: 24 }
let toolContentHeight = 150
const sessionDownloadIds = new Set<string>()
let downloadsButton = { x: 0, y: 0, width: 28, height: 29 }
let flightWindow: BrowserWindow | null = null
const recentClicks = new Map<number, { x: number; y: number; at: number }>()
type SuggestionRow = { label: string; detail: string; value: string }
let suggestionsView: WebContentsView | null = null
let suggestionsAttached = false
let suggestionsReady = false
let suggestionsPopup: { rows: SuggestionRow[]; selected: number; bounds: Electron.Rectangle } | null = null
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
const downloadTabIds = new Map<string, string>()
type PendingDownload = { id: string; item: Electron.DownloadItem; contents: Electron.WebContents | null; filename: string; host: string; total: number; start: { x: number; y: number } }
const pendingDownloads: PendingDownload[] = []
type JsDialog = { id: string; tabId: string; type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string; defaultPrompt: string; host: string }
let pendingJsDialog: JsDialog | null = null
type SwpPrompt = { id: string; kind: 'permission' | 'popup' | 'clear-data'; site: string; permission?: SwpPermission; target?: string; tabId: string; callback?: (allow: boolean) => void }
const swpPrompts: SwpPrompt[] = []
const oncePermissions = new Map<string, Set<SwpPermission>>()
const blockedAdsBySite = new Map<string, number>()
const storageBySite = new Map<string, { cookies: number; bytes: number }>()
const lastViewBounds = new WeakMap<WebContentsView, Electron.Rectangle>()
let networkPublishTimer: ReturnType<typeof setTimeout> | null = null
let framePublishTimer: ReturnType<typeof setTimeout> | null = null
const publishedState = new Map<number, string>()

function publishSoon() {
  if (!networkPublishTimer) networkPublishTimer = setTimeout(() => { networkPublishTimer = null; publish() }, 150)
}

function publicState() {
  const activeTab = current()
  return {
    privateMode,
    defaultBrowser: !privateMode && app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https'),
    activeId,
    sdtOpen: sdt?.isOpen ?? false,
    maximized: window?.isMaximized() ?? false,
    fullscreenMode: videoFullscreenTabId ? 'video' : appFullscreen ? 'app' : 'none',
    panel,
    downloadsOpen,
    toolPopover,
    globalBassDb,
    globalBassFrequency,
    certificate: activeTab?.certificate ?? { status: 'none' },
    pageSafety: pageSafety(activeTab),
    sessionDownloadIds: [...sessionDownloadIds],
    pendingDownload: pendingDownloads[0] ? { id: pendingDownloads[0].id, filename: pendingDownloads[0].filename, host: pendingDownloads[0].host, total: pendingDownloads[0].total } : null,
    jsDialog: pendingJsDialog,
    swpPrompt: swpPrompts[0] ? { id: swpPrompts[0].id, kind: swpPrompts[0].kind, site: swpPrompts[0].site, permission: swpPrompts[0].permission, target: swpPrompts[0].target } : null,
    swp: current()?.site ? { site: current()!.site!, adblock: adblockEnabled(current()!.site!), blockedSite: blockedAdsBySite.get(current()!.site!) ?? 0, blockedTotal: swpData().blockedTotal, popupBlockedTotal: swpData().popupBlockedTotal, listUpdatedAt: swpData().listUpdatedAt, listStatus: swpData().listStatus, permissions: swpData().permissions[current()!.site!] ?? {}, popup: popupFor(current()!.site!), clearOnExit: clearOnExit(current()!.site!), storage: storageBySite.get(current()!.site!) ?? { cookies: 0, bytes: 0 } } : null,
    library: getLibrary(),
    privacy: null,
    tabs: tabs.map(({ id, title, url, favicon, loading, loadEpoch, audible, muted, bassDb, bassStatus, error, closing, hibernated, view }) => ({
      id, title, url, favicon, loading, loadEpoch, audible, muted, bassDb, bassStatus, error, closing, hibernated,
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
    })),
  }
}

function publish() {
  if (!framePublishTimer) framePublishTimer = setTimeout(() => { framePublishTimer = null; publishNow() }, 16)
}

function stateFor(contents: Electron.WebContents) {
  const state = publicState()
  const library = getLibrary()
  if (contents === window.webContents) return { ...state, privacy: null, library: { bookmarks: library.bookmarks, history: library.history.slice(0, 100), downloads: library.downloads, quickLinks: library.quickLinks, extensions: library.extensions, settings: library.settings } }
  if (contents === panelView?.webContents) return { ...state, library: { bookmarks: panel === 'bookmarks' ? library.bookmarks : [], history: panel === 'history' ? library.history : [], downloads: [], quickLinks: [], extensions: panel === 'extensions' ? library.extensions : [], settings: library.settings }, privacy: panel === 'privacy' && current()?.site ? { ...requestSummary(current()!.site!), protection: current()!.protection } : null }
  if (contents === downloadsView?.webContents) return { ...state, library: { bookmarks: [], history: [], downloads: library.downloads, quickLinks: [], extensions: [], settings: library.settings }, privacy: null }
  if (contents === toolView?.webContents) return { ...state, library: { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: library.settings }, privacy: null }
  if (contents === downloadConfirmView?.webContents) return { ...state, tabs: [], library: { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: library.settings }, privacy: null }
  if (contents === jsDialogView?.webContents) return { ...state, tabs: [], library: { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: library.settings }, privacy: null }
  if (contents === swpPromptView?.webContents) return { ...state, tabs: [], library: { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: library.settings }, privacy: null }
  if (contents === suggestionsView?.webContents) return { suggestionsPopup }
  return state
}

function sendState(contents: Electron.WebContents) {
  if (contents.isDestroyed()) return
  const state = stateFor(contents)
  const signature = JSON.stringify(state)
  if (publishedState.get(contents.id) === signature) return
  publishedState.set(contents.id, signature)
  contents.send('browser:state', state)
}

function publishNow() {
  if (!window || window.isDestroyed()) return
  sdt?.layout()
  sendState(window.webContents)
  for (const view of [panelView, downloadsView, toolView, downloadConfirmView, jsDialogView, swpPromptView, suggestionsView]) if (view) sendState(view.webContents)
}

function current() { return tabs.find(tab => tab.id === activeId) }

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!) }
function dataPage(body: string, css: string) {
  return `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}</style></head><body>${body}</body></html>`)}`
}
let connectivityCache = { online: false, checkedAt: 0 }
async function hasInternetAccess() {
  if (!net.isOnline()) return false
  if (Date.now() - connectivityCache.checkedAt < 5000) return connectivityCache.online
  const signal = AbortSignal.timeout(2600)
  const checks = ['https://www.gstatic.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace'].map(url => net.fetch(url, { method: 'GET', cache: 'no-store', signal }).then(response => response.ok).catch(() => false))
  const online = (await Promise.all(checks)).some(Boolean)
  connectivityCache = { online, checkedAt: Date.now() }
  return online
}
function networkErrorPage(url: string, code: number, description: string, online: boolean | null) {
  const checking = online === null
  const offline = online === false
  const refused = code === -102
  const dns = code === -105
  const title = checking ? 'Kapcsolat ellenőrzése…' : offline ? 'Nincs internetkapcsolat' : refused ? 'A webszerver nem válaszol' : dns ? 'A webcím nem található' : 'A webhely nem érhető el'
  const detail = checking ? 'A Skipy ellenőrzi, hogy az internetkapcsolat vagy a megnyitott webhely hibásodott-e meg.' : offline ? 'A Skipy nem tudta elérni az internetet. Ellenőrizd a hálózati kapcsolatot, majd próbáld újra.' : refused ? 'Az internet működik, de a megadott kiszolgáló visszautasította a kapcsolatot.' : dns ? 'Az internet működik, de ehhez a webcímhez nem található kiszolgáló.' : 'Az internet működik, de ez a webhely pillanatnyilag nem válaszol.'
  const body = `<main><div class="mark">!</div><p class="brand">SKIPY <b>BROWSER</b></p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><code>${escapeHtml(url)}</code><div class="actions"><a href="${escapeHtml(url)}">Próbáld újra</a></div><small>${escapeHtml(description)} · ${code}</small></main>`
  const css = `*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#080809;color:#eef0f3;font-family:Segoe UI,Arial,sans-serif}body{display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 50% 45%,#25160d 0,transparent 38%),#080809}main{width:min(560px,100%);text-align:center}.mark{width:64px;height:64px;display:grid;place-items:center;margin:0 auto 20px;border:1px solid #834010;border-radius:19px;background:#2f1d12;color:#ff7d20;font-size:30px;font-weight:800;box-shadow:0 0 34px #ff650021}.brand{margin:0 0 28px;color:#8f949e;font-size:10px;font-weight:700;letter-spacing:3px}.brand b{color:#ff7d20}h1{margin:0 0 12px;font-size:28px}p{margin:0 auto 18px;color:#aeb3bd;font-size:14px;line-height:1.55}code{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#777f8d;font:11px Consolas,monospace}.actions{margin:28px 0 22px}.actions a{display:inline-block;padding:11px 20px;border-radius:10px;background:#ff781b;color:#1b0f08;text-decoration:none;font-size:13px;font-weight:800;box-shadow:0 8px 24px #ff650024}.actions a:hover{background:#ff9145}small{color:#666d79;font-size:10px}`
  return dataPage(body, css)
}
function removeNotice() {
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = null
  activeNoticeMessage = ''
  const view = noticeView
  noticeView = null
  if (view) {
    if (noticeAttached && window && !window.isDestroyed()) window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
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

function setViewBounds(view: WebContentsView, bounds: Electron.Rectangle) {
  const previous = lastViewBounds.get(view)
  if (previous && previous.x === bounds.x && previous.y === bounds.y && previous.width === bounds.width && previous.height === bounds.height) return
  view.setBounds(bounds)
  lastViewBounds.set(view, bounds)
}

function layout() {
  if (!window || window.isDestroyed()) return
  const [width, height] = window.getContentSize()
  const full = appFullscreen || !!videoFullscreenTabId
  if (full) {
    if (panelView && panelAttached) { window.contentView.removeChildView(panelView); panelAttached = false }
    if (downloadsView && downloadsAttached) { window.contentView.removeChildView(downloadsView); downloadsAttached = false }
    if (toolView && toolAttached) { window.contentView.removeChildView(toolView); toolAttached = false }
    if (suggestionsView && suggestionsAttached) { window.contentView.removeChildView(suggestionsView); suggestionsAttached = false; suggestionsPopup = null }
  } else {
    if (panel && panelView && !panelAttached && !panelView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(panelView); panelAttached = true }
    if (downloadsOpen && downloadsView && !downloadsAttached && !downloadsView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(downloadsView); downloadsAttached = true }
    if (toolPopover && toolView && !toolAttached && !toolView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(toolView); toolAttached = true }
  }
  const top = full ? 0 : TOOLBAR_HEIGHT
  for (const tab of tabs) {
    if (tab.view && tab.id === activeId) {
      setViewBounds(tab.view, { x: 0, y: top, width: Math.max(0, width), height: Math.max(0, height - top) })
    }
  }
  if (transitionView) setViewBounds(transitionView, { x: 0, y: 0, width, height })
  if (panelView) setViewBounds(panelView, { x: Math.max(0, width - PANEL_WIDTH), y: TOOLBAR_HEIGHT, width: Math.min(PANEL_WIDTH, width), height: Math.max(0, height - TOOLBAR_HEIGHT) })
  if (downloadsView) setViewBounds(downloadsView, { x: Math.max(0, Math.min(width - 330, Math.round(downloadsButton.x + downloadsButton.width - 330))), y: 42, width: Math.min(330, width), height: Math.min(420, Math.max(0, height - 42)) })
  if (downloadConfirmView) setViewBounds(downloadConfirmView, { x: 0, y: 0, width, height })
  if (jsDialogView) setViewBounds(jsDialogView, { x: 0, y: 0, width, height })
  if (swpPromptView) setViewBounds(swpPromptView, { x: 0, y: 0, width, height })
  if (suggestionsView && suggestionsPopup) setViewBounds(suggestionsView, suggestionsPopup.bounds)
  if (toolView) {
    const margin = 8
    const popoverWidth = Math.max(0, Math.min(340, width - margin * 2))
    const preferredY = Math.round(toolAnchor.y + toolAnchor.height + 6)
    const y = Math.max(42, Math.min(Math.max(42, height - 150), preferredY))
    const x = Math.max(margin, Math.min(Math.max(margin, width - popoverWidth - margin), Math.round(toolAnchor.x)))
    setViewBounds(toolView, { x, y, width: popoverWidth, height: Math.min(toolContentHeight, Math.max(0, height - y - margin)) })
  }
  for (const tab of tabs) if (tab.audioView) setViewBounds(tab.audioView, { x: Math.max(0, width - 1), y: Math.max(0, height - 1), width: 1, height: 1 })
  if (noticeView) setViewBounds(noticeView, { x: Math.max(0, Math.floor((width - 420) / 2)), y: Math.max(0, height - 103), width: Math.min(420, width), height: 64 })
  sdt?.layout()
}

function overlayView(kind: 'panel' | 'downloads') {
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  view.setBackgroundColor('#00000000')
  view.webContents.on('did-finish-load', () => {
    if (kind === 'panel' ? !!panel : downloadsOpen) showOverlay(kind)
    publish()
  })
  void view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'), { query: { overlay: kind } })
  return view
}

function closeSuggestions() {
  suggestionsPopup = null
  if (suggestionsView && suggestionsAttached && !window.isDestroyed()) window.contentView.removeChildView(suggestionsView)
  suggestionsAttached = false
  publish()
}

function ensureSuggestionsView() {
  if (suggestionsView) return
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  suggestionsView = view
  view.setBackgroundColor('#00000000')
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', event => event.preventDefault())
  view.webContents.on('did-finish-load', () => {
    suggestionsReady = true
    if (suggestionsPopup && !suggestionsAttached) { window.contentView.addChildView(view); suggestionsAttached = true; layout() }
    publish()
  })
  void view.webContents.loadFile(path.join(__dirname, '..', 'dist', 'suggestions.html'))
}

function showSuggestions(rows: SuggestionRow[], selected: number, rawBounds: Electron.Rectangle) {
  const [windowWidth, windowHeight] = window.getContentSize()
  const x = Math.max(0, Math.min(windowWidth - 180, Math.round(rawBounds.x)))
  const y = Math.max(TOOLBAR_HEIGHT, Math.round(rawBounds.y + rawBounds.height + 6))
  const width = Math.max(180, Math.min(Math.round(rawBounds.width), windowWidth - x))
  const height = Math.max(46, Math.min(rows.length * 42 + 12, 340, windowHeight - y - 8))
  suggestionsPopup = { rows, selected: Math.max(0, Math.min(selected, rows.length - 1)), bounds: { x, y, width, height } }
  ensureSuggestionsView()
  if (suggestionsView && suggestionsReady && !suggestionsAttached) { window.contentView.addChildView(suggestionsView); suggestionsAttached = true }
  layout(); publish()
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
  downloadsOpen = open && getLibrary().downloads.length > 0
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
    toolContentHeight = toolPopover === 'certificate' ? 150 : 280
    ensureToolView()
  } else if (toolView && toolAttached) {
    window.contentView.removeChildView(toolView)
    toolAttached = false
  }
  layout(); publish()
}

function ensureToolView() {
  if (toolView) return
  toolView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  toolView.setBackgroundColor('#00000000')
  toolView.webContents.on('did-finish-load', () => { layout(); publish() })
  void toolView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'), { query: { overlay: 'tool' } })
}

function scheduleDownloadsClose() {
  if (popupTimer) clearTimeout(popupTimer)
  if (getLibrary().downloads.some(entry => sessionDownloadIds.has(entry.id) && (entry.status === 'progressing' || entry.status === 'paused'))) return
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
  if (!next || next.closing) return
  const previous = current()
  if (previous && previous.id !== id) previous.lastActiveAt = Date.now()
  if (previous?.view) window.contentView.removeChildView(previous.view)
  activeId = id
  next.lastActiveAt = Date.now()
  if (next.hibernated && next.url !== HOME_URL) {
    next.hibernated = false
    attachPage(next)
    void loadPage(next, next.url)
  }
  sdt?.bind()
  if (toolPopover) { toolPopover = null; if (toolView && toolAttached) { window.contentView.removeChildView(toolView); toolAttached = false } }
  if (next.view) window.contentView.addChildView(next.view)
  sdt?.pageAttached()
  for (const [overlay, attached] of [[panelView, panelAttached], [downloadsView, downloadsAttached], [toolView, toolAttached]] as const) if (overlay && attached) { window.contentView.removeChildView(overlay); window.contentView.addChildView(overlay) }
  layout()
  publish()
}

function hibernateTab(tabId: string, automatic = false) {
  const tab = tabs.find(item => item.id === tabId)
  if (!tab || tab.id === activeId || tab.hibernated || !tab.view || tab.audible || tab.bassStatus === 'active' || [...downloadTabIds.values()].includes(tab.id)) {
    if (!automatic && tab?.id === activeId) notice('Az aktív lap nem hibernálható.', 'error')
    return
  }
  stopBass(tab, false)
  const view = tab.view
  tab.view = null
  tab.hibernated = true; tab.loading = false; tab.audible = false
  if (!view.webContents.isDestroyed()) view.webContents.close()
  if (!automatic) notice(`Lap hibernálva: ${tab.title}`)
  publish()
}

function runAutoHibernation() {
  const minutes = getLibrary().settings.autoHibernateMinutes
  if (!minutes) return
  const threshold = Date.now() - minutes * 60_000
  for (const tab of tabs) if (tab.id !== activeId && tab.lastActiveAt < threshold) hibernateTab(tab.id, true)
}

function configuredHome() { return getLibrary().settings.homepage === 'skipy' ? HOME_URL : getLibrary().settings.homepage }

function fingerprintSeed(site: string) { return createHmac('sha256', secret()).update(site).digest().readUInt32BE(0) }

function loadPage(tab: Tab, url: string) {
  if (!tab.view || tab.view.webContents.isDestroyed()) return
  tab.protection = 'pending'
  const view = tab.view
  void (async () => {
    await Promise.race([tab.certReady ?? Promise.resolve(), new Promise<void>(resolve => setTimeout(resolve, 1500))])
    if (tab.view === view) {
      const contents = view.webContents
      if (contents && !contents.isDestroyed()) await contents.loadURL(url).catch(() => undefined)
    }
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
    const adBlocked = isAdRequest(site, host)
    const blocked = adBlocked || isBlocked(site, host)
    if (adBlocked) { blockedAdsBySite.set(site, (blockedAdsBySite.get(site) ?? 0) + 1); recordAdBlocked() }
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
function pageSafety(tab?: Tab) {
  if (!tab || tab.url === HOME_URL) return { level: 'safe' as const, title: 'Skipy helyi oldal', reasons: ['Nem küld adatot külső webhelynek.'] }
  const reasons: string[] = []
  let level: 'safe' | 'warning' | 'danger' = 'safe'
  try {
    const parsed = new URL(tab.url)
    if (parsed.protocol !== 'https:') { level = 'warning'; reasons.push('A kapcsolat nincs HTTPS-sel titkosítva.') }
    if (parsed.username || parsed.password) { level = 'danger'; reasons.push('A webcím bejelentkezési adatot tartalmaz.') }
    if (parsed.hostname.includes('xn--')) { if (level !== 'danger') level = 'warning'; reasons.push('A domain nemzetközi karakteres, ezért ellenőrizd a címét.') }
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname)) { if (level !== 'danger') level = 'warning'; reasons.push('A webhely domainnév helyett közvetlen IP-címet használ.') }
    if (tab.certificate.status === 'error') { level = 'danger'; reasons.push('A HTTPS-tanúsítvány hibás.') }
    else if (parsed.protocol === 'https:' && tab.certificate.status !== 'secure') { if (level !== 'danger') level = 'warning'; reasons.push('A tanúsítvány adatai nem ellenőrizhetők.') }
    if (tab.site && !adblockEnabled(tab.site)) { if (level === 'safe') level = 'warning'; reasons.push('Az SWP védelem ezen a webhelyen ki van kapcsolva.') }
  } catch { return { level: 'danger' as const, title: 'Érvénytelen webcím', reasons: ['A webcím nem értelmezhető biztonságosan.'] } }
  if (!reasons.length) reasons.push('HTTPS-kapcsolat és aktív SWP védelem.')
  return { level, title: level === 'safe' ? 'Nem találtunk helyi biztonsági problémát' : level === 'warning' ? 'Figyelmet igénylő oldal' : 'Veszélyes kapcsolat', reasons }
}
function monitorCertificate(tab: Tab, wc: Electron.WebContents) {
  const debuggerApi = wc.debugger
  debuggerApi.on('message', (_event, method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      const dialogType = params?.type
      if (!['alert', 'confirm', 'prompt', 'beforeunload'].includes(dialogType) || pendingJsDialog) {
        if (pendingJsDialog) void debuggerApi.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
        return
      }
      let host = 'Weboldal'
      try { host = new URL(params.url || wc.getURL()).host || host } catch { /* Use the safe label. */ }
      pendingJsDialog = { id: id(), tabId: tab.id, type: dialogType, message: String(params.message || '').slice(0, 4000), defaultPrompt: String(params.defaultPrompt || '').slice(0, 2000), host }
      syncJsDialog()
      return
    }
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
    if (pendingJsDialog?.tabId === tab.id) { pendingJsDialog = null; syncJsDialog() }
    if (/^https:\/\//i.test(tab.url) && tab.certificate.status !== 'error') { tab.certificate = { status: 'unavailable', host: new URL(tab.url).host }; publish() }
  })
  tab.certReady = (async () => {
    try { debuggerApi.attach('1.3'); await Promise.all([debuggerApi.sendCommand('Network.enable'), debuggerApi.sendCommand('Page.enable')]) }
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
      view.webContents.send('audio:start', tab.bassDb, globalBassFrequency, tab.muted)
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
  else if (tab.audioView && !tab.audioView.webContents.isDestroyed()) tab.audioView.webContents.send('audio:update', db, globalBassFrequency, tab.muted)
  else startBass(tab)
  publish()
}

function setGlobalBass(db: number, frequency: number) {
  globalBassDb = db
  globalBassFrequency = frequency
  for (const tab of tabs) setBass(tab, db)
  publish()
}

function contextDownload(tab: Tab, url: string, x: number, y: number) {
  if (!tab.view || !/^https?:\/\//i.test(url)) return
  recentClicks.set(tab.view.webContents.id, { x, y, at: Date.now() })
  tab.view.webContents.downloadURL(url)
}

async function savePage(tab: Tab) {
  if (!tab.view || tab.view.webContents.isDestroyed()) return
  const title = (tab.title || 'weboldal').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90) || 'weboldal'
  const result = await dialog.showSaveDialog(window, { title: 'Weboldal mentése', defaultPath: path.join(app.getPath('downloads'), `${title}.html`), filters: [{ name: 'Teljes weboldal', extensions: ['html'] }] })
  if (result.canceled || !result.filePath) return
  try { await tab.view.webContents.savePage(result.filePath, 'HTMLComplete'); notice('A weboldal mentése elkészült.') }
  catch { notice('A weboldal mentése nem sikerült.', 'error') }
}

function attachContextMenu(tab: Tab, wc: Electron.WebContents) {
  wc.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []
    const separator = () => { if (template.length && template.at(-1)?.type !== 'separator') template.push({ type: 'separator' }) }
    if (params.isEditable) {
      template.push(
        { label: 'Visszavonás', role: 'undo', enabled: params.editFlags.canUndo }, { label: 'Ismétlés', role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' },
        { label: 'Kivágás', role: 'cut', enabled: params.editFlags.canCut }, { label: 'Másolás', role: 'copy', enabled: params.editFlags.canCopy }, { label: 'Beillesztés', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Törlés', role: 'delete', enabled: params.editFlags.canDelete }, { label: 'Összes kijelölése', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      )
    } else if (params.selectionText.trim()) {
      const selection = params.selectionText.trim()
      template.push({ label: 'Másolás', role: 'copy' }, { label: `Keresés: „${selection.slice(0, 45)}${selection.length > 45 ? '…' : ''}”`, click: () => createTab(resolveInput(selection), false) })
    }
    if (/^https?:\/\//i.test(params.linkURL)) {
      separator()
      template.push(
        { label: 'Link megnyitása új lapon', click: () => createTab(params.linkURL, false) },
        { label: 'Link letöltése', click: () => contextDownload(tab, params.linkURL, params.x, params.y) },
        { label: 'Link címének másolása', click: () => clipboard.writeText(params.linkURL) },
      )
    }
    if (params.mediaType === 'image' && /^https?:\/\//i.test(params.srcURL)) {
      separator()
      template.push(
        { label: 'Kép megnyitása új lapon', click: () => createTab(params.srcURL, false) },
        { label: 'Kép mentése', click: () => contextDownload(tab, params.srcURL, params.x, params.y) },
        { label: 'Kép másolása', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Kép címének másolása', click: () => clipboard.writeText(params.srcURL) },
      )
    } else if ((params.mediaType === 'audio' || params.mediaType === 'video') && /^https?:\/\//i.test(params.srcURL)) {
      separator()
      const media = params.mediaType === 'video' ? 'Videó' : 'Hang'
      template.push(
        { label: `${media} megnyitása új lapon`, click: () => createTab(params.srcURL, false) },
        { label: `${media} mentése`, click: () => contextDownload(tab, params.srcURL, params.x, params.y) },
        { label: `${media} címének másolása`, click: () => clipboard.writeText(params.srcURL) },
      )
    }
    separator()
    template.push(
      { label: 'Vissza', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Előre', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Újratöltés', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Weboldal mentése…', click: () => { void savePage(tab) } },
      { label: 'Nyomtatás…', click: () => wc.print({ printBackground: true }) },
      { label: 'Elem vizsgálata', click: () => wc.inspectElement(params.x, params.y) },
    )
    Menu.buildFromTemplate(template).popup({ window })
  })
}

function attachPage(tab: Tab) {
  const view = new WebContentsView({ webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
    disableDialogs: true,
    disableHtmlFullscreenWindowResize: true,
    preload: path.join(__dirname, 'fingerprint-preload.js'),
  } })
  tab.view = view
  const wc = view.webContents
  let showingErrorPage = false
  attachContextMenu(tab, wc)
  monitorCertificate(tab, wc)
  wc.on('input-event', (_event, input) => {
    if (input.type === 'mouseDown') closeSuggestions()
    if (input.type === 'mouseUp' && 'x' in input && 'y' in input && typeof input.x === 'number' && typeof input.y === 'number') recentClicks.set(wc.id, { x: input.x, y: input.y, at: Date.now() })
  })
  wc.on('audio-state-changed', event => { tab.audible = event.audible; publish() })
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!/^https?:\/\//i.test(url)) return { action: 'deny' }
    const site = tab.site || siteForUrl(wc.getURL())
    if (!site) return { action: 'deny' }
    const directTab = disposition === 'foreground-tab' || disposition === 'background-tab'
    const click = recentClicks.get(wc.id)
    const userTriggered = !!click && Date.now() - click.at < 1200
    const rule = popupFor(site)
    if (directTab || userTriggered || rule === 'allow') setImmediate(() => createTab(url, disposition !== 'background-tab'))
    else if (rule !== 'block') { swpPrompts.push({ id: id(), kind: 'popup', site, target: url, tabId: tab.id }); syncSwpPrompt() }
    else recordPopupBlocked()
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault()
  })
  wc.on('did-start-navigation', details => {
    if (details.isMainFrame) sdt?.documentNavigation(tab.id)
    if (showingErrorPage && !details.url.startsWith('data:text/html')) showingErrorPage = false
    if (details.isMainFrame && !details.isSameDocument) {
      if (tab.site) oncePermissions.delete(`${tab.id}:${tab.site}`)
      tab.favicon = null; tab.site = siteForUrl(details.url)
      tab.certCandidates.clear(); tab.certificate = certificateForUrl(details.url)
      if (tab.audioView) stopBass(tab, false)
      publish()
    }
  })
  wc.on('did-start-loading', () => { tab.loading = true; tab.loadEpoch++; if (!showingErrorPage) tab.error = null; publish() })
  wc.on('did-stop-loading', () => { tab.loading = false; publish() })
  wc.on('did-navigate', (_event, url) => { if (showingErrorPage && url.startsWith('data:text/html')) return; tab.url = url; tab.site = siteForUrl(url); tab.certificate = tab.certCandidates.get(certificateKey(url)) ?? certificateForUrl(url); publish() })
  wc.on('did-navigate-in-page', (_event, url) => { tab.url = url; publish() })
  wc.on('did-finish-load', () => {
    if (tab.id === activeId) sdt?.bind()
    if (tab.certificate.status === 'loading') { tab.certificate = { status: 'unavailable', host: /^https:\/\//i.test(wc.getURL()) ? new URL(wc.getURL()).host : undefined }; publish() }
    if (tab.bassDb > 0 && !tab.audioView && !tab.error) startBass(tab)
    if (tab.protection === 'pending') setTimeout(() => { if (tab.protection === 'pending') { tab.protection = 'error'; publish() } }, 150)
    if (tab.error || !/^https?:\/\//i.test(wc.getURL())) return
    if (tab.site && adblockEnabled(tab.site)) void wc.insertCSS(cosmeticCss(), { cssOrigin: 'user' }).catch(() => undefined)
    const url = wc.getURL()
    const title = wc.getTitle() || url
    tab.url = url
    if (!privateMode) {
      const history = getLibrary().history
      history.unshift({ id: id(), title, url, visitedAt: Date.now(), ...(tab.favicon ? { favicon: tab.favicon } : {}) })
      if (history.length > 1000) history.length = 1000
      saveLibrary()
    }
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
    if (isMainFrame && code !== -3 && !url.startsWith('data:text/html')) {
      tab.error = `Az oldal nem tölthető be: ${description}`; tab.url = url; tab.title = 'Betöltési hiba'; tab.loading = false
      if (tab.certificate.status === 'loading') tab.certificate = { status: 'unavailable', host: /^https:\/\//i.test(url) ? new URL(url).host : undefined }
      if (tab.protection === 'pending') tab.protection = 'error'
      showingErrorPage = true
      const failedUrl = url
      void (async () => {
        await wc.loadURL(networkErrorPage(failedUrl, code, description, null))
        let local = false
        try { const host = new URL(failedUrl).hostname; local = host === 'localhost' || host === '127.0.0.1' || host === '::1' } catch { /* Not a normal URL. */ }
        const online = local || code === -102 ? true : code === -106 ? false : await hasInternetAccess()
        if (!tab.view || tab.view.webContents !== wc || (!showingErrorPage && tab.url !== failedUrl)) return
        await wc.loadURL(networkErrorPage(failedUrl, code, description, online))
        tab.url = failedUrl; tab.loading = false; publish()
      })().catch(() => undefined)
      publish()
    }
  })
  wc.on('certificate-error', (_event, url, error, _certificate, _callback, isMainFrame) => {
    if (isMainFrame) { tab.certificate = { status: 'error', host: /^https:\/\//i.test(url) ? new URL(url).host : undefined, error }; publish() }
  })
  wc.on('before-input-event', (event, input) => handleShortcut(input, event))
  wc.on('did-navigate-in-page', () => { if (tab.id === activeId) sdt?.bind() })
  wc.on('render-process-gone', () => sdt?.navigation(tab.id))
  wc.on('destroyed', () => sdt?.navigation(tab.id))
  wc.on('enter-html-full-screen', () => {
    if (tab.id !== activeId) return
    videoFullscreenTabId = tab.id
    sdt?.close()
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

function createTab(input = configuredHome(), activate = true) {
  const tab: Tab = { id: String(nextId++), view: null, title: 'Új lap', url: input === HOME_URL ? HOME_URL : resolveInput(input), favicon: null, loading: false, loadEpoch: 0, audible: false, muted: false, bassDb: globalBassDb, bassStatus: 'off', audioView: null, certificate: certificateForUrl(input === HOME_URL ? HOME_URL : resolveInput(input)), certCandidates: new Map(), certReady: null, error: null, site: input === HOME_URL ? null : siteForUrl(resolveInput(input)), protection: 'pending', closing: false, hibernated: false, lastActiveAt: Date.now() }
  tabs.push(tab)
  if (input !== HOME_URL) {
    attachPage(tab)
    void loadPage(tab, resolveInput(input))
  }
  if (activate || !activeId) showTab(tab.id)
  else publish()
  if (activate && window && !window.isDestroyed()) setTimeout(() => window.webContents.send('browser:focus-address'), 0)
  return tab
}

function navigate(input: string) {
  const tab = current()
  if (!tab) return
  sdt?.navigation(tab.id)
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
    sdt?.bind()
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
  const tab = tabs.find(item => item.id === id)
  if (!tab || tab.closing) return
  sdt?.navigation(id)
  tab.closing = true
  closeTimers.set(id, setTimeout(() => finishCloseTab(id), 360))
  publish()
}

function finishCloseTab(id: string) {
  const index = tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  const timer = closeTimers.get(id)
  if (timer) clearTimeout(timer)
  closeTimers.delete(id)
  const [tab] = tabs.splice(index, 1)
  for (let i = swpPrompts.length - 1; i >= 0; i--) if (swpPrompts[i].tabId === id) { swpPrompts[i].callback?.(false); swpPrompts.splice(i, 1) }
  oncePermissions.delete(`${id}:${tab.site ?? ''}`)
  syncSwpPrompt()
  if (pendingJsDialog?.tabId === id) { pendingJsDialog = null; syncJsDialog() }
  stopBass(tab, true)
  if (tab.view) {
    if (id === activeId) window.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
  }
  if (!tabs.length) { activeId = ''; window.close(); return }
  if (id === activeId) {
    activeId = ''
    const available = [...tabs.slice(index), ...tabs.slice(0, index)].find(item => !item.closing)
    if (available) showTab(available.id)
    else publish()
  }
  else publish()
}

function toggleDevTools() {
  const contents = current()?.view?.webContents ?? window.webContents
  if (contents.isDestroyed()) return
  if (contents.isDevToolsOpened()) contents.closeDevTools()
  else contents.openDevTools({ mode: 'detach', activate: true })
}

function handleShortcut(input: Electron.Input, event?: { preventDefault(): void }) {
  if (input.type !== 'keyDown') return
  const ctrl = input.control || input.meta
  const key = input.key.toLowerCase()
  if (ctrl && input.shift && key === 'n') {
    event?.preventDefault()
    launchBrowserWindow(true)
  }
  else if (ctrl && key === 'n') {
    event?.preventDefault()
    launchBrowserWindow(false)
  }
  else if (key === 'f12' || (ctrl && input.shift && key === 'i')) {
    event?.preventDefault()
    toggleDevTools()
  }
  else if (ctrl && input.shift && key === 'd' && getLibrary().settings.developerMode) {
    event?.preventDefault()
    sdt?.toggle()
  }
  else if (key === 'f11') {
    if (videoFullscreenTabId) return
    event?.preventDefault()
    appFullscreen = !appFullscreen
    if (appFullscreen) sdt?.close()
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

function launchBrowserWindow(isPrivate: boolean) {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const flags = [`--skipy-window=${token}`, ...(isPrivate ? ['--skipy-private'] : [])]
  const args = app.isPackaged ? flags : [app.getAppPath(), ...flags]
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch {
    notice('Az új böngészőablak nem indítható el.', 'error')
  }
}

async function loadSavedExtensions() {
  for (const entry of getLibrary().extensions) {
    if (!entry.enabled) continue
    try {
      const loaded = await session.defaultSession.extensions.loadExtension(entry.path, { allowFileAccess: true })
      entry.id = loaded.id; entry.name = loaded.name
    } catch { entry.enabled = false }
  }
  saveLibrary(); publish()
}

async function chooseExtension() {
  const selected = await dialog.showOpenDialog(window, { title: 'Kicsomagolt bővítmény betöltése', properties: ['openDirectory'] })
  if (selected.canceled || !selected.filePaths[0]) return
  const extensionPath = selected.filePaths[0]
  try {
    const loaded = await session.defaultSession.extensions.loadExtension(extensionPath, { allowFileAccess: true })
    const existing = getLibrary().extensions.find(entry => entry.path === extensionPath || entry.id === loaded.id)
    if (existing) Object.assign(existing, { id: loaded.id, name: loaded.name, path: extensionPath, enabled: true })
    else getLibrary().extensions.push({ id: loaded.id, name: loaded.name, path: extensionPath, enabled: true })
    saveLibrary(); publish(); notice(`Bővítmény betöltve: ${loaded.name}`)
  } catch (error) { notice(`A bővítmény nem tölthető be: ${error instanceof Error ? error.message : 'ismeretlen hiba'}`, 'error') }
}

function chromeExtensionId(value: string) {
  const trimmed = value.trim()
  const direct = trimmed.match(/^[a-p]{32}$/i)?.[0]
  if (direct) return direct.toLowerCase()
  try {
    const parsed = new URL(trimmed)
    if (!['chromewebstore.google.com', 'chrome.google.com'].includes(parsed.hostname.toLowerCase())) return null
    return parsed.pathname.match(/\/([a-p]{32})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null
  } catch { return null }
}

function crxZipOffset(buffer: Buffer) {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') throw new Error('A letöltött fájl nem érvényes CRX csomag.')
  const version = buffer.readUInt32LE(4)
  if (version === 3) return 12 + buffer.readUInt32LE(8)
  if (version === 2) return 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12)
  throw new Error(`Nem támogatott CRX-verzió: ${version}`)
}

async function installWebStoreExtension(value: string) {
  const extensionId = chromeExtensionId(value)
  if (!extensionId) return 'Illessz be egy Chrome Web Store-linket vagy egy 32 karakteres bővítményazonosítót.'
  const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Bővítmény telepítése', message: 'Telepíted ezt a Chrome Web Store-bővítményt?', detail: `${extensionId}\n\nA Skipy csak az Electron által támogatott bővítményfunkciókat tudja futtatni.`, buttons: ['Mégse', 'Letöltés és telepítés'], defaultId: 1, cancelId: 0, noLink: true })
  if (answer.response !== 1) return
  const extensionsRoot = path.join(app.getPath('userData'), 'skipy-extensions')
  const temporaryRoot = path.join(extensionsRoot, `.install-${extensionId}-${Date.now()}`)
  const archivePath = path.join(app.getPath('temp'), `skipy-${extensionId}-${Date.now()}.zip`)
  try {
    notice('Bővítmény letöltése…')
    const query = encodeURIComponent(`id=${extensionId}&uc`)
    const downloadUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=140.0.0.0&acceptformat=crx2,crx3&x=${query}`
    const response = await net.fetch(downloadUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`A Web Store ${response.status} hibát adott.`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 100 * 1024 * 1024) throw new Error('A bővítmény nagyobb 100 MB-nál.')
    const offset = crxZipOffset(bytes)
    if (offset >= bytes.length || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('A CRX csomag ZIP-tartalma sérült.')
    await fs.promises.mkdir(temporaryRoot, { recursive: true })
    await fs.promises.writeFile(archivePath, bytes.subarray(offset))
    await extract(archivePath, { dir: temporaryRoot })
    const manifestPath = path.join(temporaryRoot, 'manifest.json')
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as { name?: unknown; manifest_version?: unknown }
    if (typeof manifest.name !== 'string' || ![2, 3].includes(Number(manifest.manifest_version))) throw new Error('A manifest.json nem támogatott.')
    const target = path.join(extensionsRoot, extensionId)
    const old = getLibrary().extensions.find(entry => entry.path === target || entry.id === extensionId)
    if (old?.enabled) session.defaultSession.extensions.removeExtension(old.id)
    await fs.promises.rm(target, { recursive: true, force: true })
    await fs.promises.rename(temporaryRoot, target)
    const loaded = await session.defaultSession.extensions.loadExtension(target, { allowFileAccess: true })
    if (old) Object.assign(old, { id: loaded.id, name: loaded.name, path: target, enabled: true })
    else getLibrary().extensions.push({ id: loaded.id, name: loaded.name, path: target, enabled: true })
    saveLibrary(); publish(); notice(`Bővítmény telepítve: ${loaded.name}`, 'success')
  } catch (error) {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    const message = error instanceof Error ? error.message : 'ismeretlen hiba'
    notice(`A telepítés nem sikerült: ${message}`, 'error')
    return message
  } finally { await fs.promises.rm(archivePath, { force: true }).catch(() => undefined) }
}

async function toggleExtension(extensionId: string) {
  const entry = getLibrary().extensions.find(value => value.id === extensionId)
  if (!entry) return
  try {
    if (entry.enabled) { session.defaultSession.extensions.removeExtension(entry.id); entry.enabled = false }
    else { const loaded = await session.defaultSession.extensions.loadExtension(entry.path, { allowFileAccess: true }); entry.id = loaded.id; entry.name = loaded.name; entry.enabled = true }
    saveLibrary(); publish()
  } catch (error) { notice(`A bővítmény állapota nem módosítható: ${error instanceof Error ? error.message : 'ismeretlen hiba'}`, 'error') }
}

function importedBookmarks(source: string, extension: string) {
  const rows: { title: string; url: string }[] = []
  if (extension === '.html' || extension === '.htm') {
    const decode = (value: string) => value.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    for (const match of source.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = decode(match[1]); const title = decode(match[2].replace(/<[^>]+>/g, '').trim()) || url
      if (/^https?:\/\//i.test(url)) rows.push({ title: title.slice(0, 300), url })
    }
  } else {
    const parsed = JSON.parse(source) as any
    const visit = (node: any) => { if (!node || typeof node !== 'object') return; if (typeof node.url === 'string' && /^https?:\/\//i.test(node.url)) rows.push({ title: typeof node.name === 'string' && node.name ? node.name.slice(0, 300) : node.url, url: node.url }); if (Array.isArray(node.children)) node.children.forEach(visit); else for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value) }
    visit(parsed.roots ?? parsed)
  }
  return rows
}

async function importBrowserBookmarks() {
  const selected = await dialog.showOpenDialog(window, { title: 'Könyvjelzők importálása másik böngészőből', properties: ['openFile'], filters: [{ name: 'Böngésző könyvjelzők', extensions: ['html', 'htm', 'json'] }] })
  if (selected.canceled || !selected.filePaths[0]) return
  try {
    const sourcePath = selected.filePaths[0]
    const rows = importedBookmarks(await fs.promises.readFile(sourcePath, 'utf8'), path.extname(sourcePath).toLowerCase())
    const known = new Set(getLibrary().bookmarks.map(entry => entry.url)); let added = 0
    for (const row of rows) if (!known.has(row.url)) { known.add(row.url); getLibrary().bookmarks.push({ id: id(), title: row.title, url: row.url, createdAt: Date.now() }); added++ }
    saveLibrary(); publish(); notice(`${added} könyvjelző importálva.`)
  } catch { notice('A kiválasztott böngészőadat nem olvasható.', 'error') }
}

async function exportBookmarks() {
  const selected = await dialog.showSaveDialog(window, { title: 'Könyvjelzők exportálása', defaultPath: path.join(app.getPath('documents'), 'skipy-bookmarks.html'), filters: [{ name: 'Böngésző könyvjelzők', extensions: ['html'] }] })
  if (selected.canceled || !selected.filePath) return
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const links = getLibrary().bookmarks.map(entry => `<DT><A HREF="${escape(entry.url)}" ADD_DATE="${Math.floor(entry.createdAt / 1000)}">${escape(entry.title)}</A>`).join('\n')
  await fs.promises.writeFile(selected.filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Skipy könyvjelzők</TITLE>\n<H1>Skipy könyvjelzők</H1>\n<DL><p>\n${links}\n</DL><p>\n`, 'utf8')
  notice('A könyvjelzők exportálva.')
}

async function exportSkipyBackup() {
  const selected = await dialog.showSaveDialog(window, { title: 'Skipy biztonsági mentés', defaultPath: path.join(app.getPath('documents'), 'skipy-backup.json'), filters: [{ name: 'Skipy biztonsági mentés', extensions: ['json'] }] })
  if (selected.canceled || !selected.filePath) return
  await fs.promises.writeFile(selected.filePath, JSON.stringify({ format: 'skipy-backup', version: 1, exportedAt: new Date().toISOString(), library: getLibrary() }, null, 2), 'utf8')
  notice('A Skipy biztonsági mentés elkészült.')
}

let resetting = false
async function resetBrowser() {
  const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Skipy teljes visszaállítása', message: 'Minden helyi adat törlődik', detail: 'A könyvjelzők, előzmények, letöltési lista, bővítmények, beállítások, engedélyek és webhelyadatok végleg törlődnek.', buttons: ['Mégse', 'Teljes reset'], defaultId: 0, cancelId: 0, noLink: true })
  if (answer.response !== 1) return
  resetting = true
  for (const extension of session.defaultSession.extensions.getAllExtensions()) session.defaultSession.extensions.removeExtension(extension.id)
  await Promise.all([session.defaultSession.clearStorageData(), session.defaultSession.clearCache()]).catch(() => undefined)
  try { fs.rmSync(path.join(app.getPath('userData'), 'skipy-data'), { recursive: true, force: true }) } catch { /* Relaunch will retry with a clean profile. */ }
  dataFlushedForQuit = true
  app.relaunch({ args: process.argv.slice(1).filter(argument => !argument.startsWith('--skipy-window=') && argument !== '--skipy-private') })
  app.quit()
}

function configurePlatformQuickActions() {
  if (process.platform === 'win32') app.setUserTasks([
    { program: process.execPath, arguments: '--skipy-new-window', iconPath: process.execPath, iconIndex: 0, title: 'Új ablak', description: 'Új Skipy böngészőablak' },
    { program: process.execPath, arguments: '--skipy-private', iconPath: process.execPath, iconIndex: 0, title: 'Új inkognitó ablak', description: 'Privát Skipy böngészés' },
  ])
  if (process.platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate([
    { label: 'Új ablak', click: () => launchBrowserWindow(false) },
    { label: 'Új inkognitó ablak', click: () => launchBrowserWindow(true) },
  ]))
}

function toggleBookmark() {
  const tab = current()
  if (!tab || !/^https?:\/\//i.test(tab.url)) return
  const bookmarks = getLibrary().bookmarks
  const index = bookmarks.findIndex(item => item.url === tab.url)
  if (index >= 0) { bookmarks.splice(index, 1); notice('Könyvjelző eltávolítva.') }
  else { bookmarks.unshift({ id: id(), title: tab.title || tab.url, url: tab.url, createdAt: Date.now(), folder: 'Kedvencek', ...(tab.favicon ? { favicon: tab.favicon } : {}) }); notice('Hozzáadva a Kedvencekhez.') }
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

function syncDownloadConfirmation() {
  if (!pendingDownloads.length) {
    if (downloadConfirmView && downloadConfirmAttached) { window.contentView.removeChildView(downloadConfirmView); downloadConfirmAttached = false }
    publish(); return
  }
  if (!downloadConfirmView) ensureDownloadConfirmView()
  if (downloadConfirmView && !downloadConfirmAttached && !downloadConfirmView.webContents.isLoadingMainFrame()) {
    window.contentView.addChildView(downloadConfirmView); downloadConfirmAttached = true; layout()
  }
  publish()
}

function ensureDownloadConfirmView() {
  if (downloadConfirmView) return
  downloadConfirmView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  downloadConfirmView.setBackgroundColor('#00000000')
  downloadConfirmView.webContents.on('did-finish-load', () => { if (pendingDownloads.length) syncDownloadConfirmation(); publish() })
  void downloadConfirmView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'), { query: { overlay: 'download-confirm' } })
}

function ensureJsDialogView() {
  if (jsDialogView) return
  jsDialogView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  jsDialogView.setBackgroundColor('#00000000')
  jsDialogView.webContents.on('did-finish-load', () => { if (pendingJsDialog) syncJsDialog(); publish() })
  void jsDialogView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'), { query: { overlay: 'js-dialog' } })
}

function syncJsDialog() {
  if (!pendingJsDialog) {
    if (jsDialogView && jsDialogAttached) { window.contentView.removeChildView(jsDialogView); jsDialogAttached = false }
    publish(); return
  }
  ensureJsDialogView()
  if (jsDialogView && !jsDialogAttached && !jsDialogView.webContents.isLoadingMainFrame()) {
    window.contentView.addChildView(jsDialogView); jsDialogAttached = true; layout()
  }
  publish()
}

function answerJsDialog(dialogId: string, accept: boolean, promptText = '') {
  const pending = pendingJsDialog
  if (!pending || pending.id !== dialogId) return
  const tab = tabs.find(item => item.id === pending.tabId)
  pendingJsDialog = null
  syncJsDialog()
  if (!tab?.view || tab.view.webContents.isDestroyed() || !tab.view.webContents.debugger.isAttached()) return
  void tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept, ...(pending.type === 'prompt' && accept ? { promptText: promptText.slice(0, 2000) } : {}) }).catch(() => undefined)
}

function ensureSwpPromptView() {
  if (swpPromptView) return
  swpPromptView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
  swpPromptView.setBackgroundColor('#00000000')
  swpPromptView.webContents.on('did-finish-load', () => { if (swpPrompts.length) syncSwpPrompt(); publish() })
  void swpPromptView.webContents.loadFile(path.join(__dirname, '..', 'dist', 'overlay.html'), { query: { overlay: 'swp-prompt' } })
}
function syncSwpPrompt() {
  if (!swpPrompts.length) {
    if (swpPromptView && swpPromptAttached) { window.contentView.removeChildView(swpPromptView); swpPromptAttached = false }
    publish(); return
  }
  ensureSwpPromptView()
  if (swpPromptView && !swpPromptAttached && !swpPromptView.webContents.isLoadingMainFrame()) { window.contentView.addChildView(swpPromptView); swpPromptAttached = true; layout() }
  publish()
}
function answerSwpPrompt(promptId: string, decision: 'once' | 'always-allow' | 'always-block' | 'deny') {
  const index = swpPrompts.findIndex(item => item.id === promptId); if (index < 0) return
  const [prompt] = swpPrompts.splice(index, 1)
  const allow = decision === 'once' || decision === 'always-allow'
  if (prompt.kind === 'permission' && prompt.permission) {
    if (decision === 'always-allow') setPermission(prompt.site, prompt.permission, 'allow')
    else if (decision === 'always-block') setPermission(prompt.site, prompt.permission, 'block')
    else if (decision === 'once') { const key = `${prompt.tabId}:${prompt.site}`; oncePermissions.get(key)?.add(prompt.permission) ?? oncePermissions.set(key, new Set([prompt.permission])) }
    prompt.callback?.(allow)
  } else if (prompt.kind === 'popup') {
    if (decision === 'always-allow') setPopup(prompt.site, 'allow')
    else if (decision === 'always-block') setPopup(prompt.site, 'block')
    if (allow && prompt.target) createTab(prompt.target, false)
    else if (!allow) recordPopupBlocked()
  } else {
    prompt.callback?.(allow)
  }
  syncSwpPrompt()
}
async function refreshSiteStorage(site: string) {
  const tab = tabs.find(item => item.site === site && item.view)
  if (!tab?.view) return
  let cookies = 0, bytes = 0
  try { cookies = (await session.defaultSession.cookies.get({ domain: site })).length } catch { /* Keep zero. */ }
  try {
    const origin = new URL(tab.url).origin
    const result = await tab.view.webContents.debugger.sendCommand('Storage.getUsageAndQuota', { origin })
    bytes = typeof result?.usage === 'number' ? result.usage : 0
  } catch { /* Quota details are optional. */ }
  storageBySite.set(site, { cookies, bytes }); publish()
}
async function clearSiteData(site: string) {
  const tab = tabs.find(item => item.site === site)
  if (!tab) return
  const origin = new URL(tab.url).origin
  await session.defaultSession.clearStorageData({ origin, storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'] })
  storageBySite.set(site, { cookies: 0, bytes: 0 }); publish()
}

function activateDownload(pending: PendingDownload, customPath?: string) {
  const { item } = pending
  const savePath = customPath || uniqueDownloadPath(pending.filename)
  item.setSavePath(savePath)
  const entry: DownloadEntry = { id: id(), name: path.basename(savePath), path: savePath, url: item.getURL(), received: 0, total: item.getTotalBytes(), status: 'progressing', startedAt: Date.now() }
  getLibrary().downloads.unshift(entry)
  sessionDownloadIds.add(entry.id)
  runningDownloads.set(entry.id, item)
  const sourceTab = tabs.find(tab => tab.view?.webContents.id === pending.contents?.id)
  if (sourceTab) downloadTabIds.set(entry.id, sourceTab.id)
  setDownloadsOpen(true)
  flyDownload(pending.start)
  item.on('updated', (_event, status) => {
    entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes()
    entry.status = item.isPaused() ? 'paused' : status === 'interrupted' ? 'interrupted' : 'progressing'
    publish()
  })
  item.on('done', (_event, status) => {
    entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes(); entry.status = status
    const actualPath = item.getSavePath()
    if (actualPath) { entry.path = actualPath; entry.name = path.basename(actualPath) }
    notice(status === 'completed' ? `Letöltve: ${entry.name}` : `A letöltés ${status === 'cancelled' ? 'megszakadt' : 'nem sikerült'}.`, status === 'completed' ? 'success' : 'error')
    runningDownloads.delete(entry.id); downloadTabIds.delete(entry.id); scheduleDownloadsClose(); saveLibrary(); publish()
  })
  saveLibrary(); item.resume(); publish()
}

async function decideDownload(pendingId: string, mode: 'default' | 'custom' | 'reject') {
  const index = pendingDownloads.findIndex(entry => entry.id === pendingId)
  if (index < 0) return
  const pending = pendingDownloads[index]
  let customPath: string | undefined
  if (mode === 'custom') {
    const result = await dialog.showSaveDialog(window, { title: 'Letöltés mentése', defaultPath: path.join(app.getPath('downloads'), pending.filename) })
    if (result.canceled || !result.filePath) return
    customPath = result.filePath
  }
  pendingDownloads.splice(index, 1)
  if (mode === 'reject') pending.item.cancel()
  else activateDownload(pending, customPath)
  syncDownloadConfirmation()
}

function trackDownloads() {
  session.defaultSession.on('will-download', (_event, item, contents) => {
    item.pause()
    if (!item.isPaused()) { item.cancel(); notice('A letöltés nem szüneteltethető biztonságosan.', 'error'); return }
    const sourceTab = tabs.find(tab => tab.view?.webContents.id === contents?.id)
    const click = contents && recentClicks.get(contents.id)
    const [width, height] = window.getContentSize()
    const start = sourceTab && click && Date.now() - click.at < 1800
      ? { x: click.x + sourceTab.view!.getBounds().x, y: click.y + sourceTab.view!.getBounds().y }
      : { x: width / 2, y: (height + TOOLBAR_HEIGHT) / 2 }
    let host = 'ismeretlen forrás'
    try { host = new URL(item.getURL()).host || host } catch { /* Keep the safe fallback. */ }
    const pending: PendingDownload = { id: id(), item, contents: contents ?? null, filename: item.getFilename(), host, total: item.getTotalBytes(), start }
    pendingDownloads.push(pending)
    item.on('done', () => {
      const pendingIndex = pendingDownloads.findIndex(entry => entry.id === pending.id)
      if (pendingIndex >= 0) { pendingDownloads.splice(pendingIndex, 1); syncDownloadConfirmation() }
    })
    syncDownloadConfirmation()
  })
}

if (hasSingleInstanceLock) void app.whenReady().then(() => {
  loadLibrary()
  loadPrivacy()
  loadSwp()
  void loadSavedExtensions()
  configurePlatformQuickActions()
  void updateLists().then(() => publish())
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
      tab.audioView?.webContents.send('audio:update', tab.bassDb, globalBassFrequency, tab.muted)
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
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'fullscreen' && isBrowserTab(contents) || (permission === 'display-capture' || permission === 'media') && isAudioProcessor(contents)) { callback(true); return }
    const tab = tabs.find(item => item.view?.webContents === contents)
    const mapped: SwpPermission | null = permission === 'notifications' ? 'notifications' : permission === 'media' ? ((details as Electron.MediaAccessPermissionRequest).mediaTypes?.includes('video') ? 'camera' : 'microphone') : null
    if (!tab?.site || !mapped || tab.id !== activeId) { callback(false); return }
    const stored = permissionFor(tab.site, mapped)
    if (stored) { callback(stored === 'allow'); return }
    if (oncePermissions.get(`${tab.id}:${tab.site}`)?.has(mapped)) { callback(true); return }
    swpPrompts.push({ id: id(), kind: 'permission', site: tab.site, permission: mapped, tabId: tab.id, callback }); syncSwpPrompt()
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (permission === 'fullscreen' && isBrowserTab(contents) || (permission === 'display-capture' || permission === 'media') && isAudioProcessor(contents)) return true
    const tab = tabs.find(item => item.view?.webContents === contents)
    const mapped: SwpPermission | null = permission === 'notifications' ? 'notifications' : permission === 'media' ? ((details as Electron.MediaAccessPermissionRequest).mediaTypes?.includes('video') ? 'camera' : 'microphone') : null
    if (!tab?.site || !mapped) return false
    return permissionFor(tab.site, mapped) === 'allow' || !!oncePermissions.get(`${tab.id}:${tab.site}`)?.has(mapped)
  })
  window = new BrowserWindow({
    width: 1280, height: 820, minWidth: 680, minHeight: 400,
    title: privateMode ? 'Skipy Browser – Inkognitó' : 'Skipy Browser', backgroundColor: '#111113', frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
    },
  })
  sdt = new SdtService({
    window,
    dataPath: path.join(app.getPath('userData'), 'skipy-data'),
    enabled: () => getLibrary().settings.developerMode,
    active: () => {
      const tab = current()
      if (!tab?.view || tab.closing || tab.error || tab.view.webContents.isDestroyed()) return null
      const url = tab.view.webContents.getURL(), site = siteForUrl(url)
      return site && /^https?:\/\//i.test(url) ? { id: tab.id, site, url, contents: tab.view.webContents } : null
    },
    canShow: () => !appFullscreen && !videoFullscreenTabId && !pendingJsDialog && !pendingDownloads.length && !swpPrompts.length,
    changed: publish,
  })
  transitionSurface = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
  transitionSurface.setBackgroundColor('#00000000')
  const transitionCss = `html{margin:0;width:100%;height:100%;background:transparent}body{margin:0;width:100%;height:100%;background:#080809;overflow:hidden;opacity:1;transition:opacity .28s cubic-bezier(.22,1,.36,1)}body.reveal{opacity:0}body:after{content:"";position:absolute;left:50%;top:50%;width:42vmax;height:42vmax;border-radius:50%;background:radial-gradient(circle,#17100c 0,#0b0908 35%,#080809 72%);transform:translate(-50%,-50%) scale(.7);opacity:.55}body.zoom:after{animation:zoom .42s cubic-bezier(.22,1,.36,1) both}@keyframes zoom{to{transform:translate(-50%,-50%) scale(1.45);opacity:.16}}@media(prefers-reduced-motion:reduce){body,body.zoom:after{transition:none;animation:none}}`
  void transitionSurface.webContents.loadURL(dataPage('', transitionCss)).catch(() => undefined)
  window.on('closed', () => {
    void sdt?.dispose().catch(() => undefined)
    if (pendingJsDialog) answerJsDialog(pendingJsDialog.id, false)
    for (const prompt of swpPrompts.splice(0)) prompt.callback?.(false)
    for (const pending of pendingDownloads.splice(0)) pending.item.cancel()
    for (const tab of tabs) stopBass(tab, true)
    if (transitionSurface && !transitionSurface.webContents.isDestroyed()) transitionSurface.webContents.close()
    if (suggestionsView && !suggestionsView.webContents.isDestroyed()) suggestionsView.webContents.close()
    suggestionsView = null
    transitionSurface = null
  })
  window.on('resize', layout)
  window.on('move', () => { if (flightWindow && !flightWindow.isDestroyed()) flightWindow.setBounds(window.getBounds()) })
  window.on('enter-full-screen', () => { layout(); publish() })
  window.on('leave-full-screen', () => { if (!videoFullscreenTabId) appFullscreen = false; layout(); publish() })
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.webContents.on('before-input-event', (event, input) => handleShortcut(input, event))
  window.webContents.on('did-finish-load', () => {
    publish()
    setTimeout(() => window.webContents.send('browser:focus-address'), 0)
    setTimeout(() => { if (!panelView) panelView = overlayView('panel') }, 250)
    setTimeout(() => ensureToolView(), 450)
    setTimeout(() => { if (!downloadsView) downloadsView = overlayView('downloads') }, 650)
    setTimeout(() => ensureDownloadConfirmView(), 850)
    setTimeout(() => ensureJsDialogView(), 1050)
    setTimeout(() => ensureSwpPromptView(), 1250)
    setTimeout(() => ensureSuggestionsView(), 1450)
  })
  void window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  createTab(pendingExternalUrl || undefined)
  pendingExternalUrl = ''
  setInterval(runAutoHibernation, 60_000).unref()

  ipcMain.handle('browser:command', (event, action: unknown, value: unknown) => {
    if (event.sender !== window.webContents && event.sender !== panelView?.webContents && event.sender !== downloadsView?.webContents && event.sender !== toolView?.webContents && event.sender !== downloadConfirmView?.webContents && event.sender !== jsDialogView?.webContents && event.sender !== swpPromptView?.webContents && event.sender !== suggestionsView?.webContents || typeof action !== 'string') return
    const text = typeof value === 'string' ? value : ''
    if (action === 'settings-developer') {
      if ((event.sender !== window.webContents && event.sender !== panelView?.webContents) || (text !== 'on' && text !== 'off')) return
      getLibrary().settings.developerMode = text === 'on'
      if (text === 'off') sdt?.disabled()
      else sdt?.bind()
      saveLibrary(); publish(); return
    }
    if (action === 'onboarding-complete') { if (event.sender === window.webContents) { getLibrary().settings.onboardingComplete = true; saveLibrary(); publish() } return }
    if (action === 'settings-hibernation') {
      if (event.sender !== panelView?.webContents) return
      const minutes = Number(text)
      if ([0, 5, 15, 30, 60].includes(minutes)) { getLibrary().settings.autoHibernateMinutes = minutes; saveLibrary(); publish() }
      return
    }
    if (action === 'settings-default-browser') {
      if (event.sender !== panelView?.webContents || privateMode) return
      const registered = app.setAsDefaultProtocolClient('http') && app.setAsDefaultProtocolClient('https')
      if (process.platform === 'win32') {
        void shell.openExternal('ms-settings:defaultapps?registeredAppUser=Skipy%20Browser').catch(() => shell.openExternal('ms-settings:defaultapps'))
        notice(registered ? 'Válaszd ki a Skipy Browsert a Windows alapértelmezett böngészőjeként.' : 'A böngésző regisztrálása nem sikerült.', registered ? 'success' : 'error')
      } else if (process.platform === 'darwin') notice(registered ? 'A Skipy Browser lett az alapértelmezett böngésző.' : 'Az alapértelmezett böngésző beállítása nem sikerült.', registered ? 'success' : 'error')
      else notice(registered ? 'A Skipy Browser regisztrálva.' : 'A beállítás nem sikerült.', registered ? 'success' : 'error')
      publish(); return
    }
    if (action === 'tab-context-menu') {
      if (event.sender !== window.webContents) return
      const tab = tabs.find(item => item.id === text); if (!tab) return
      Menu.buildFromTemplate([
        { label: tab.hibernated ? 'Lap felébresztése' : 'Lap hibernálása', enabled: tab.id !== activeId || tab.hibernated, click: () => tab.hibernated ? showTab(tab.id) : hibernateTab(tab.id) },
        { label: 'Újratöltés', enabled: !tab.hibernated, click: () => tab.view?.webContents.reload() },
        { type: 'separator' }, { label: 'Lap bezárása', click: () => closeTab(tab.id) },
      ]).popup({ window })
      return
    }
    if (action === 'hibernate-tab') { if (event.sender === window.webContents) hibernateTab(text); return }
    if (action === 'new-window') { if (event.sender === window.webContents) launchBrowserWindow(false); return }
    if (action === 'new-private-window') { if (event.sender === window.webContents) launchBrowserWindow(true); return }
    if (action === 'extension-add') { if (event.sender === panelView?.webContents || event.sender === window.webContents) void chooseExtension(); return }
    if (action === 'extension-store-install') { if (event.sender === panelView?.webContents) return installWebStoreExtension(text) }
    if (action === 'extension-toggle') { if (event.sender === panelView?.webContents) void toggleExtension(text); return }
    if (action === 'extension-remove') {
      if (event.sender !== panelView?.webContents) return
      const index = getLibrary().extensions.findIndex(entry => entry.id === text)
      if (index >= 0) { const [entry] = getLibrary().extensions.splice(index, 1); if (entry.enabled) session.defaultSession.extensions.removeExtension(entry.id); saveLibrary(); publish() }
      return
    }
    if (action === 'browser-import') { if (event.sender === panelView?.webContents) void importBrowserBookmarks(); return }
    if (action === 'bookmarks-export') { if (event.sender === panelView?.webContents) void exportBookmarks().catch(() => notice('Az exportálás nem sikerült.', 'error')); return }
    if (action === 'backup-export') { if (event.sender === panelView?.webContents) void exportSkipyBackup().catch(() => notice('A biztonsági mentés nem sikerült.', 'error')); return }
    if (action === 'browser-reset') { if (event.sender === panelView?.webContents) void resetBrowser(); return }
    if (action === 'sdt-toggle') {
      if (event.sender === window.webContents && getLibrary().settings.developerMode) sdt?.toggle()
      return
    }
    if (action === 'suggestions-open') {
      if (event.sender !== window.webContents) return
      try {
        const draft = JSON.parse(text) as { rows?: SuggestionRow[]; selected?: number; bounds?: Electron.Rectangle }
        if (!Array.isArray(draft.rows) || !draft.rows.length || draft.rows.length > 7 || !Number.isInteger(draft.selected) || !draft.bounds) return
        const rows = draft.rows.map(row => ({ label: String(row.label || '').slice(0, 1000), detail: String(row.detail || '').slice(0, 8192), value: String(row.value || '').slice(0, 8192) }))
        if (rows.some(row => !row.label || !row.value) || ![draft.bounds.x, draft.bounds.y, draft.bounds.width, draft.bounds.height].every(Number.isFinite)) return
        showSuggestions(rows, draft.selected!, draft.bounds)
      } catch { closeSuggestions() }
      return
    }
    if (action === 'copy-current-url') {
      if (event.sender !== window.webContents) return
      const url = current()?.url ?? ''
      if (/^https?:\/\//i.test(url)) { clipboard.writeText(url); notice('Link a vágólapra másolva.') }
      return
    }
    if (action === 'suggestions-close') { if (event.sender === window.webContents) closeSuggestions(); return }
    if (action === 'suggestion-choose') {
      if (event.sender !== suggestionsView?.webContents || !suggestionsPopup) return
      const row = suggestionsPopup.rows[Number(text)]
      closeSuggestions()
      if (row) navigate(row.value)
      return
    }
    // Keep IPC replies strictly data-only. Some Electron objects expose values
    // that JSON can represent but Chromium's structured clone rejects.
    if (action === 'state') return JSON.parse(JSON.stringify(stateFor(event.sender)))
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
    else if (action === 'finish-close') {
      if (event.sender === window.webContents && tabs.find(tab => tab.id === text)?.closing) finishCloseTab(text)
      return
    }
    else if (action === 'toggle-mute') {
      const tab = tabs.find(item => item.id === text)
      if (tab?.view && !tab.view.webContents.isDestroyed()) {
        tab.muted = !tab.muted
        if (tab.audioView && !tab.audioView.webContents.isDestroyed()) tab.audioView.webContents.send('audio:update', tab.bassDb, globalBassFrequency, tab.muted)
        else tab.view.webContents.setAudioMuted(tab.muted)
      }
    }
    else if (action === 'bass-set') {
      try {
        const value = JSON.parse(text) as { db: number; frequency: number }
        if (Number.isInteger(value.db) && value.db >= 0 && value.db <= 12 && Number.isInteger(value.frequency) && value.frequency >= 60 && value.frequency <= 160) setGlobalBass(value.db, value.frequency)
      } catch { /* Ignore invalid audio controls. */ }
    }
    else if (action === 'tool') {
      if (event.sender !== window.webContents) return
      try {
        const request = JSON.parse(text) as { kind: 'certificate' | 'bass'; anchor: { x: number; y: number; width: number; height: number } }
        if ((request.kind === 'certificate' || request.kind === 'bass') && request.anchor && ['x', 'y', 'width', 'height'].every(key => typeof request.anchor[key as keyof typeof request.anchor] === 'number' && Number.isFinite(request.anchor[key as keyof typeof request.anchor]))) setToolPopover(request.kind, request.anchor)
      } catch { /* Ignore invalid controls. */ }
      return
    }
    else if (action === 'tool-height') {
      if (event.sender !== toolView?.webContents || !toolPopover) return
      const requested = Number(text)
      if (Number.isFinite(requested)) {
        // scrollHeight excludes the popover's two one-pixel borders. Without
        // them Chromium exposes a scrollbar even when all content is visible.
        const nextHeight = Math.max(80, Math.min(toolPopover === 'certificate' ? 350 : 310, Math.ceil(requested) + 2))
        if (nextHeight !== toolContentHeight) { toolContentHeight = nextHeight; layout() }
      }
      return
    }
    else if (action === 'tool-close') { setToolPopover(null); return }
    else if (action === 'navigate') navigate(text)
    else if (action === 'home') navigate(configuredHome() === HOME_URL ? '' : configuredHome())
    else if (action === 'back') current()?.view?.webContents.navigationHistory.goBack()
    else if (action === 'forward') current()?.view?.webContents.navigationHistory.goForward()
    else if (action === 'reload') current()?.view?.webContents.reload()
    else if (action === 'panel') {
      if (text === 'bookmarks' || text === 'history' || text === 'settings' || text === 'privacy' || text === 'extensions') panel = panel === text ? null : text
      else if (text === 'close') panel = null
      syncPanelOverlay()
      layout()
      if (panel === 'privacy' && current()?.site) void refreshSiteStorage(current()!.site!)
    }
    else if (action === 'downloads-toggle') setDownloadsOpen(!downloadsOpen)
    else if (action === 'downloads-close') setDownloadsOpen(false)
    else if (action === 'download-confirm' || action === 'download-confirm-custom' || action === 'download-reject') {
      if (event.sender === downloadConfirmView?.webContents && pendingDownloads[0]?.id === text) void decideDownload(text, action === 'download-confirm' ? 'default' : action === 'download-confirm-custom' ? 'custom' : 'reject')
      return
    }
    else if (action === 'js-dialog-answer') {
      if (event.sender !== jsDialogView?.webContents) return
      try {
        const answer = JSON.parse(text) as { id?: unknown; accept?: unknown; promptText?: unknown }
        if (typeof answer.id === 'string' && typeof answer.accept === 'boolean') answerJsDialog(answer.id, answer.accept, typeof answer.promptText === 'string' ? answer.promptText : '')
      } catch { /* Ignore invalid dialog responses. */ }
      return
    }
    else if (action === 'swp-prompt-answer') {
      if (event.sender !== swpPromptView?.webContents) return
      try {
        const answer = JSON.parse(text) as { id?: unknown; decision?: unknown }
        if (typeof answer.id === 'string' && ['once', 'always-allow', 'always-block', 'deny'].includes(String(answer.decision))) answerSwpPrompt(answer.id, answer.decision as 'once' | 'always-allow' | 'always-block' | 'deny')
      } catch { /* Ignore malformed answers. */ }
      return
    }
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
    else if (action === 'bookmark-folder') {
      try { const value=JSON.parse(text) as {id?:unknown;folder?:unknown};const entry=typeof value.id==='string'?getLibrary().bookmarks.find(item=>item.id===value.id):undefined;const folder=typeof value.folder==='string'?value.folder.trim().slice(0,60):'';if(entry){entry.folder=folder||'Kedvencek';saveLibrary()} } catch { /* Ignore malformed folder updates. */ }
    }
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
    else if (action === 'download-pause') { const item = runningDownloads.get(text); if (item && !item.isPaused()) { item.pause(); const entry = getLibrary().downloads.find(value => value.id === text); if (entry) entry.status = 'paused' } }
    else if (action === 'download-resume') { const item = runningDownloads.get(text); if (item?.canResume()) { item.resume(); const entry = getLibrary().downloads.find(value => value.id === text); if (entry) entry.status = 'progressing' } }
    else if (action === 'download-reveal') {
      const entry = getLibrary().downloads.find(item => item.id === text && item.status === 'completed')
      if (!entry) return
      let storedPath = entry.path
      if (!fs.existsSync(storedPath)) {
        const downloadsPath = path.join(app.getPath('downloads'), path.basename(entry.name))
        if (fs.existsSync(downloadsPath)) { storedPath = downloadsPath; entry.path = downloadsPath; saveLibrary() }
      }
      if (fs.existsSync(storedPath)) shell.showItemInFolder(storedPath)
      else notice('A letöltött fájl már nem található ezen a helyen.', 'error')
    }
    else if (action === 'downloads-clear-finished') {
      const items = getLibrary().downloads
      const retained = items.filter(item => item.status === 'progressing' || item.status === 'paused')
      if (retained.length !== items.length) {
        items.splice(0, items.length, ...retained)
        for (const id of [...sessionDownloadIds]) if (!retained.some(item => item.id === id)) sessionDownloadIds.delete(id)
        saveLibrary(); notice('A befejezett letöltési előzmények törölve.')
      }
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
    else if (action === 'swp-adblock') { const site = current()?.site; if (site) { toggleAdblock(site); current()?.view?.webContents.reload(); notice(adblockEnabled(site) ? 'SWP reklámvédelem bekapcsolva.' : 'SWP reklámvédelem kikapcsolva.') } }
    else if (action === 'swp-permission-reset') { const site = current()?.site; if (site && ['camera', 'microphone', 'notifications'].includes(text)) setPermission(site, text as SwpPermission) }
    else if (action === 'swp-popup-reset') { const site = current()?.site; if (site) setPopup(site) }
    else if (action === 'swp-clear-on-exit') { const site = current()?.site; if (site) toggleClearOnExit(site) }
    else if (action === 'swp-clear-site') { const site = current()?.site; if (site) { const run = () => void clearSiteData(site).then(() => notice('A webhely helyi adatai törölve.')).catch(() => notice('A webhelyadatok törlése nem sikerült.', 'error')); if (runningDownloads.size || current()?.audible) { swpPrompts.push({ id: id(), kind: 'clear-data', site, target: 'site', tabId: activeId, callback: allow => { if (allow) run() } }); syncSwpPrompt() } else run() } }
    else if (action === 'swp-clear-all') { const run = () => void session.defaultSession.clearStorageData().then(() => { storageBySite.clear(); notice('Minden webhelyadat törölve.'); publish() }).catch(() => notice('A webhelyadatok törlése nem sikerült.', 'error')); if (runningDownloads.size || tabs.some(tab => tab.audible)) { swpPrompts.push({ id: id(), kind: 'clear-data', site: 'Minden webhely', target: 'all', tabId: activeId, callback: allow => { if (allow) run() } }); syncSwpPrompt() } else run() }
    else if (action === 'swp-update-lists') { void updateLists(true).then(ok => notice(ok ? 'Az SWP szűrőlisták frissültek.' : 'A szűrőlisták frissítése nem sikerült.', ok ? 'success' : 'error')).finally(() => publish()) }
    publish()
  })
})

let dataFlushedForQuit = false
app.on('before-quit', event => {
  if (resetting) return
  flushPrivacy()
  if (dataFlushedForQuit) return
  event.preventDefault()
  const clearMarked = privateMode
    ? Promise.all([session.defaultSession.clearStorageData().catch(() => undefined), session.defaultSession.clearCache().catch(() => undefined)])
    : Promise.all(swpData().clearOnExit.flatMap(site => ['https://', 'http://'].map(protocol => session.defaultSession.clearStorageData({ origin: `${protocol}${site}` }).catch(() => undefined))))
  void Promise.all([flushLibrary(), flushSwp(), sdt?.flush(), clearMarked]).finally(() => { dataFlushedForQuit = true; app.quit() })
})
app.on('quit', () => {
  const disposableRoot = privateRoot || (windowToken ? sessionDataPath : '')
  if (disposableRoot) { try { fs.rmSync(disposableRoot, { recursive: true, force: true }) } catch { /* Chromium may still be releasing a file handle. */ } }
})
app.on('window-all-closed', () => app.quit())
app.on('second-instance', (_event, commandLine) => {
  if (commandLine.includes('--skipy-private')) { launchBrowserWindow(true); return }
  if (commandLine.includes('--skipy-new-window')) { launchBrowserWindow(false); return }
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  const externalUrl = commandLine.find(argument => /^https?:\/\//i.test(argument))
  if (externalUrl) createTab(externalUrl)
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (!/^https?:\/\//i.test(url)) return
  if (app.isReady() && window && !window.isDestroyed()) createTab(url)
  else pendingExternalUrl = url
})
