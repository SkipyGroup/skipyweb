import './style.css'
import { createIcons, ArrowLeft, ArrowRight, RotateCw, House, Shield, Bookmark, BookOpen, History, Download, SlidersHorizontal, Minus, Square, X, Globe, Search, Grid2X2, Plus, Pencil, Trash2, Copy, Star, Volume2, VolumeX, AudioLines, LockKeyhole, TriangleAlert } from 'lucide'
import { classifyInput } from '../main/input'

const iconSet = { ArrowLeft, ArrowRight, RotateCw, House, Shield, Bookmark, BookOpen, History, Download, SlidersHorizontal, Minus, Square, X, Globe, Search, Grid2X2, Plus, Pencil, Trash2, Copy, Star, Volume2, VolumeX, AudioLines, LockKeyhole, TriangleAlert }
function renderIcons() { createIcons({ icons: iconSet, attrs: { 'stroke-width': 2 } }) }
function icon(name: string) {
  const element = document.createElement('i')
  element.setAttribute('data-lucide', name)
  return element
}
function setIcon(element: HTMLElement, name: string) { if (element.dataset.iconName !== name) { element.dataset.iconName = name; element.replaceChildren(icon(name)) } }

type Tab = { id: string; title: string; url: string; favicon: string | null; loading: boolean; loadEpoch: number; audible: boolean; muted: boolean; bassDb: number; bassStatus: 'off' | 'starting' | 'active' | 'error'; error: string | null; canGoBack: boolean; canGoForward: boolean; closing: boolean }
type CertificateState = { status: 'none' | 'loading' | 'secure' | 'error' | 'unavailable'; host?: string; subject?: string; issuer?: string; validFrom?: number; validTo?: number; protocol?: string; cipher?: string; error?: string }
type Bookmark = { id: string; title: string; url: string; createdAt: number; favicon?: string }
type HistoryEntry = { id: string; title: string; url: string; visitedAt: number; favicon?: string }
type DownloadEntry = { id: string; name: string; path: string; url: string; received: number; total: number; status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; startedAt: number }
type QuickLink = { id: string; title: string; url: string }
type Privacy = { site: string; protection: 'active' | 'error' | 'pending'; fingerprintEnabled: boolean; blockedHosts: string[]; rows: { site: string; host: string; count: number; blocked: number; lastSeen: number; blockedNow: boolean }[] }
type State = { activeId: string; globalBassDb: number; globalBassFrequency: number; maximized: boolean; fullscreenMode: 'none' | 'app' | 'video'; tabs: Tab[]; panel: 'bookmarks' | 'history' | 'downloads' | 'settings' | 'privacy' | null; downloadsOpen: boolean; sessionDownloadIds: string[]; pendingDownload: { id: string; filename: string; host: string; total: number } | null; toolPopover: 'certificate' | 'bass' | null; certificate: CertificateState; privacy: Privacy | null; library: { bookmarks: Bookmark[]; history: HistoryEntry[]; downloads: DownloadEntry[]; quickLinks: QuickLink[]; settings: { searchEngine: 'google' | 'duckduckgo' | 'bing'; homepage: string } } }
type BrowserBridge = {
  command: (action: string, value?: string) => Promise<State | string | void>
  onState: (callback: (state: State) => void) => () => void
  onFocusAddress: (callback: () => void) => () => void
  onOverlayClose: (callback: () => void) => () => void
  onDownloadLand: (callback: () => void) => () => void
}
declare global { interface Window { browser: BrowserBridge } }

const $ = (id: string) => document.getElementById(id)!
const tabsElement = $('tabs')
const address = $('address') as HTMLInputElement
const homeSearch = $('home-search') as HTMLInputElement
const home = $('home-screen')
const overlayMode = new URLSearchParams(location.search).get('overlay')
if (overlayMode === 'panel' || overlayMode === 'downloads' || overlayMode === 'tool' || overlayMode === 'download-confirm') document.body.classList.add(`overlay-${overlayMode}`)
let overlayClosing = false
let lastOverlayPanel: State['panel'] = null
const tabElements = new Map<string, HTMLElement>()
let state: State = { activeId: '', globalBassDb: 0, globalBassFrequency: 95, maximized: false, fullscreenMode: 'none', tabs: [], panel: null, downloadsOpen: false, sessionDownloadIds: [], pendingDownload: null, toolPopover: null, certificate: { status: 'none' }, privacy: null, library: { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: { searchEngine: 'google', homepage: 'skipy' } } }
let homeModeDraft: 'skipy' | 'custom' | null = null
let homepageDraft: string | null = null
let settingsError = ''
let renderedActiveId = ''
let progressKey = ''
let progressStarted = 0
let progressTimer: ReturnType<typeof setInterval> | null = null
let progressFinishTimer: ReturnType<typeof setTimeout> | null = null
let suggestionsInset = 0
let lastDownloadButtonBounds = ''
type Suggestion = { label: string; detail: string; value: string; action: 'navigate' | 'history' }
const suggestionState = new Map<HTMLInputElement, { rows: Suggestion[]; selected: number }>()

function command(action: string, value?: string) { void window.browser.command(action, value) }
function focusAddress() { address.focus(); address.select() }

function suggestionMenu(input: HTMLInputElement) { return $(input === address ? 'address-suggestions' : 'home-suggestions') }
function setSuggestionsInset(value: number) {
  if (value === suggestionsInset) return
  suggestionsInset = value
  command('suggestion-inset', String(value))
}
function closeSuggestions(input: HTMLInputElement) {
  const menu = suggestionMenu(input)
  menu.hidden = true
  menu.replaceChildren()
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-activedescendant')
  suggestionState.delete(input)
  if (input === address) setSuggestionsInset(0)
}
function buildSuggestions(value: string): Suggestion[] {
  const query = value.trim()
  if (!query) return []
  const kind = classifyInput(query)
  const engine = state.library.settings.searchEngine
  const rows: Suggestion[] = [{ label: kind === 'url' ? `Megnyitás: ${query}` : `Keresés: ${query}`, detail: kind === 'url' ? 'Webcím' : ({ google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' }[engine]), value: query, action: 'navigate' }]
  const seen = new Set<string>()
  for (const entry of state.library.history) {
    if (seen.has(entry.url) || !`${entry.title} ${entry.url}`.toLocaleLowerCase('hu-HU').includes(query.toLocaleLowerCase('hu-HU'))) continue
    seen.add(entry.url)
    rows.push({ label: entry.title || entry.url, detail: entry.url, value: entry.url, action: 'history' })
    if (rows.length >= 7) break
  }
  return rows
}
function showSuggestions(input: HTMLInputElement) {
  const menu = suggestionMenu(input)
  const rows = buildSuggestions(input.value)
  if (!rows.length || document.activeElement !== input) { closeSuggestions(input); return }
  const selected = Math.min(suggestionState.get(input)?.selected ?? 0, rows.length - 1)
  suggestionState.set(input, { rows, selected })
  menu.replaceChildren()
  rows.forEach((row, index) => {
    const option = document.createElement('button')
    option.type = 'button'
    option.id = `${menu.id}-option-${index}`
    option.className = `suggestion${index === selected ? ' selected' : ''}`
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(index === selected))
    const label = document.createElement('strong')
    label.textContent = row.label
    const detail = document.createElement('span')
    detail.textContent = row.detail
    option.append(label, detail)
    option.addEventListener('mousedown', event => event.preventDefault())
    option.addEventListener('click', () => chooseSuggestion(input, index))
    menu.append(option)
  })
  menu.hidden = false
  if (input === address) setSuggestionsInset(Math.min(400, Math.max(0, Math.ceil(menu.getBoundingClientRect().bottom - $('load-progress').getBoundingClientRect().bottom + 8))))
  input.setAttribute('aria-expanded', 'true')
  input.setAttribute('aria-activedescendant', `${menu.id}-option-${selected}`)
}
function chooseSuggestion(input: HTMLInputElement, index: number) {
  const row = suggestionState.get(input)?.rows[index]
  if (!row) return false
  closeSuggestions(input)
  input.blur()
  if (input === homeSearch) homeSearch.value = ''
  command('navigate', row.value)
  return true
}
function wireSuggestions(input: HTMLInputElement) {
  input.addEventListener('input', () => showSuggestions(input))
  input.addEventListener('focus', () => showSuggestions(input))
  input.addEventListener('blur', () => closeSuggestions(input))
  input.addEventListener('keydown', event => {
    const current = suggestionState.get(input)
    if (event.key === 'Escape') { closeSuggestions(input); input.blur(); if (input === address) address.value = state.tabs.find(tab => tab.id === state.activeId)?.url === 'skipy://home' ? '' : state.tabs.find(tab => tab.id === state.activeId)?.url ?? ''; return }
    if (!current) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      current.selected = (current.selected + (event.key === 'ArrowDown' ? 1 : -1) + current.rows.length) % current.rows.length
      showSuggestions(input)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      chooseSuggestion(input, current.selected)
    }
  })
}

function updateProgress(active?: Tab) {
  const track = $('load-progress')
  const fill = $('load-progress-fill') as HTMLElement
  const key = active?.loading ? `${active.id}:${active.loadEpoch}` : ''
  if (key && key !== progressKey) {
    progressKey = key
    progressStarted = Date.now()
    if (progressFinishTimer) clearTimeout(progressFinishTimer)
    if (progressTimer) clearInterval(progressTimer)
    track.hidden = false
    fill.style.width = '4%'
    progressTimer = setInterval(() => {
      const elapsed = Date.now() - progressStarted
      fill.style.width = `${Math.min(90, 10 + 80 * (1 - Math.exp(-elapsed / 2500)))}%`
    }, 80)
  } else if (!key && progressKey) {
    progressKey = ''
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = null
    fill.style.width = '100%'
    progressFinishTimer = setTimeout(() => { if (!progressKey) track.hidden = true }, 260)
  }
}
function updateDownloadsButton() {
  if (overlayMode) return
  const button = $('show-downloads')
  const rect = button.getBoundingClientRect()
  const bounds = JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  if (bounds !== lastDownloadButtonBounds) { lastDownloadButtonBounds = bounds; command('downloads-button-bounds', bounds) }
  const ids = new Set(state.sessionDownloadIds)
  const active = state.library.downloads.filter(entry => ids.has(entry.id) && entry.status === 'progressing')
  const unknown = active.some(entry => entry.total <= 0)
  const total = active.reduce((sum, entry) => sum + Math.max(0, entry.total), 0)
  const received = active.reduce((sum, entry) => sum + Math.min(Math.max(0, entry.received), Math.max(0, entry.total)), 0)
  button.classList.toggle('downloading', active.length > 0)
  button.classList.toggle('download-unknown', unknown)
  button.classList.toggle('selected', state.downloadsOpen)
  button.style.setProperty('--download-progress', `${total > 0 ? Math.round(received / total * 100) : 0}%`)
}

function updateClock() {
  const now = new Date()
  $('home-time').textContent = new Intl.DateTimeFormat('hu-HU', { hour: '2-digit', minute: '2-digit' }).format(now)
  $('home-date').textContent = new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now).toLocaleUpperCase('hu-HU')
  $('home-greeting').textContent = now.getHours() < 10 ? 'Jó reggelt!' : now.getHours() < 18 ? 'Jó napot!' : 'Jó estét!'
}
updateClock()
setTimeout(function minuteTick() { updateClock(); setTimeout(minuteTick, 60000 - Date.now() % 60000 + 20) }, 60000 - Date.now() % 60000 + 20)

function editQuickLink(link?: QuickLink) {
  const dialog = $('quicklink-dialog') as HTMLDialogElement
  const form = $('quicklink-form') as HTMLFormElement
  form.reset()
  $('quicklink-error').textContent = ''
  $('quicklink-dialog-title').textContent = link ? 'Gyors elérés szerkesztése' : 'Új gyors elérés'
  ;($('quicklink-title') as HTMLInputElement).value = link?.title ?? ''
  ;($('quicklink-url') as HTMLInputElement).value = link?.url ?? ''
  ;($('quicklink-id') as HTMLInputElement).value = link?.id ?? ''
  dialog.showModal()
  ;($('quicklink-title') as HTMLInputElement).focus()
}

function renderQuickLinks() {
  const grid = $('quick-links')
  const signature = JSON.stringify(state.library.quickLinks)
  if (grid.dataset.signature === signature) return
  grid.dataset.signature = signature
  grid.replaceChildren()
  for (const link of state.library.quickLinks) {
    const card = document.createElement('div')
    card.className = 'quick-card'
    const open = document.createElement('button')
    open.className = 'quick-open'
    const emblem = document.createElement('span')
    emblem.className = 'quick-emblem'
    emblem.append(icon('globe'))
    const name = document.createElement('span')
    name.className = 'quick-name'
    name.textContent = link.title
    open.append(emblem, name)
    open.title = link.url
    open.addEventListener('click', () => command('quicklink-open', link.id))
    const controls = document.createElement('div')
    controls.className = 'quick-controls'
    const edit = document.createElement('button')
    edit.append(icon('pencil')); edit.title = 'Szerkesztés'; edit.setAttribute('aria-label', `${link.title} szerkesztése`)
    edit.addEventListener('click', () => editQuickLink(link))
    const remove = document.createElement('button')
    remove.append(icon('trash-2')); remove.title = 'Törlés'; remove.setAttribute('aria-label', `${link.title} törlése`)
    remove.addEventListener('click', () => command('quicklink-remove', link.id))
    controls.append(edit, remove)
    card.append(open, controls)
    grid.append(card)
  }
  if (state.library.quickLinks.length < 6) {
    const add = document.createElement('button')
    add.className = 'quick-add'
    const plus = document.createElement('span')
    plus.append(icon('plus'))
    const label = document.createElement('strong')
    label.textContent = 'Hozzáadás'
    add.append(plus, label)
    add.addEventListener('click', () => editQuickLink())
    grid.append(add)
  }
}

function favicon(url?: string | null, fallback = 'globe') {
  const wrap = document.createElement('span')
  wrap.className = 'favicon-wrap'
  const symbol = document.createElement('span')
  symbol.append(icon(fallback))
  wrap.append(symbol)
  if (url && /^https?:\/\//i.test(url)) {
    const image = document.createElement('img')
    image.hidden = true
    image.referrerPolicy = 'no-referrer'
    image.alt = ''
    image.addEventListener('load', () => { image.hidden = false; symbol.hidden = true })
    image.addEventListener('error', () => { image.remove(); symbol.hidden = false })
    wrap.append(image)
    image.src = url
  }
  return wrap
}

function settingLabel(label: string, control: HTMLElement) {
  const block = document.createElement('label')
  block.className = 'setting-field'
  const caption = document.createElement('span')
  caption.textContent = label
  block.append(caption, control)
  return block
}

function renderSettings(container: HTMLElement) {
  const search = document.createElement('select')
  for (const [value, label] of [['google', 'Google'], ['duckduckgo', 'DuckDuckGo'], ['bing', 'Bing']]) {
    const option = document.createElement('option')
    option.value = value; option.textContent = label; search.append(option)
  }
  search.value = state.library.settings.searchEngine
  search.addEventListener('change', () => command('settings-search', search.value))
  container.append(settingLabel('Címsori kereső', search))

  const mode = document.createElement('select')
  for (const [value, label] of [['skipy', 'Skipy kezdőlap'], ['custom', 'Egyedi webcím']]) {
    const option = document.createElement('option')
    option.value = value; option.textContent = label; mode.append(option)
  }
  mode.value = homeModeDraft ?? (state.library.settings.homepage === 'skipy' ? 'skipy' : 'custom')
  mode.addEventListener('change', () => {
    homeModeDraft = mode.value as 'skipy' | 'custom'
    settingsError = ''
    if (homeModeDraft === 'skipy') {
      void window.browser.command('settings-home', 'skipy').then(() => { homeModeDraft = null; homepageDraft = null })
    } else render(state)
  })
  container.append(settingLabel('Új lap és Home gomb', mode))

  if (mode.value === 'custom') {
    const form = document.createElement('form')
    form.className = 'setting-form'
    const input = document.createElement('input')
    input.type = 'url'; input.placeholder = 'https://pelda.hu/'
    input.value = homepageDraft ?? (state.library.settings.homepage === 'skipy' ? '' : state.library.settings.homepage)
    input.addEventListener('input', () => { homepageDraft = input.value })
    const save = document.createElement('button')
    save.type = 'submit'; save.textContent = 'Mentés'
    form.append(input, save)
    form.addEventListener('submit', event => {
      event.preventDefault()
      void window.browser.command('settings-home', input.value).then(result => {
        settingsError = typeof result === 'string' ? result : ''
        if (settingsError) command('notice-error', settingsError)
        if (!settingsError) { homeModeDraft = null; homepageDraft = null }
        render(state)
      })
    })
    container.append(form)
  }
  if (settingsError) {
    const message = document.createElement('p')
    message.className = 'setting-error'
    message.textContent = settingsError
    container.append(message)
  }
}

function renderPrivacy(container: HTMLElement, actions: HTMLElement) {
  const privacy = state.privacy
  if (!privacy) {
    const empty = document.createElement('p')
    empty.className = 'panel-empty'
    empty.textContent = 'Nyiss meg egy weboldalt a kérésfigyelőhöz.'
    container.append(empty)
    return
  }
  const site = document.createElement('div')
  site.className = 'privacy-site'
  site.textContent = `Webhely: ${privacy.site}`
  container.append(site)
  const protection = document.createElement('div')
  protection.className = 'privacy-protection'
  const status = document.createElement('span')
  status.textContent = !privacy.fingerprintEnabled ? 'Ujjlenyomat-védelem: kikapcsolva' : privacy.protection === 'active' ? 'Ujjlenyomat-védelem: aktív' : privacy.protection === 'error' ? 'Ujjlenyomat-védelem: hiba' : 'Ujjlenyomat-védelem: indul'
  protection.append(status, actionButton(privacy.fingerprintEnabled ? 'Kikapcsolás' : 'Bekapcsolás', 'privacy-fingerprint', privacy.fingerprintEnabled ? 'off' : 'on'))
  container.append(protection)
  const heading = document.createElement('h3')
  heading.className = 'privacy-heading'
  heading.textContent = 'Kommunikáció célhostonként'
  container.append(heading)
  actions.append(actionButton('Webhely naplójának törlése', 'privacy-clear-site'))
  actions.append(actionButton('Összes napló törlése', 'privacy-clear-all'))
  const rows = [...privacy.rows]
  for (const host of privacy.blockedHosts) {
    if (!rows.some(row => row.host === host)) rows.push({ site: privacy.site, host, count: 0, blocked: 0, lastSeen: 0, blockedNow: true })
  }
  if (!rows.length) {
    const empty = document.createElement('p')
    empty.className = 'panel-empty'
    empty.textContent = 'Még nincs hálózati kérés ezen a webhelyen.'
    container.append(empty)
  }
  for (const row of rows) {
    const item = document.createElement('div')
    item.className = 'library-row'
    const title = document.createElement('div')
    title.className = 'row-title'
    title.textContent = row.host
    const summary = document.createElement('div')
    summary.className = 'row-subtitle'
    summary.textContent = `${row.count} kérés · ${row.blocked} tiltva${row.lastSeen ? ` · ${new Date(row.lastSeen).toLocaleString('hu-HU')}` : ''}`
    const footer = document.createElement('div')
    footer.className = 'row-footer'
    footer.append(actionButton(row.blockedNow ? 'Feloldás' : 'Letiltás', 'privacy-block', row.host))
    item.append(title, summary, footer)
    container.append(item)
  }
}

function actionButton(label: string, action: string, id?: string) {
  const button = document.createElement('button')
  button.className = 'row-action'
  button.textContent = label
  button.addEventListener('click', event => { event.stopPropagation(); command(action, id) })
  return button
}

function renderPanel() {
  const panel = $('library-panel')
  panel.hidden = !state.panel
  home.classList.toggle('panel-open', !!state.panel && state.fullscreenMode === 'none')
  for (const [kind, button] of [['bookmarks', 'show-bookmarks'], ['history', 'show-history'], ['downloads', 'show-downloads'], ['settings', 'show-settings'], ['privacy', 'show-privacy']]) {
    $(button).classList.toggle('selected', state.panel === kind)
  }
  const list = $('panel-list')
  const actions = $('panel-actions')
  list.replaceChildren(); actions.replaceChildren()
  if (!state.panel) return
  const labels = { bookmarks: 'Könyvjelzők', history: 'Előzmények', downloads: 'Letöltések', settings: 'Beállítások', privacy: 'Adatvédelem' }
  $('panel-title').textContent = labels[state.panel]
  if (state.panel === 'settings') { renderSettings(list); return }
  if (state.panel === 'privacy') { renderPrivacy(list, actions); return }
  if (state.panel === 'history' && state.library.history.length) actions.append(actionButton('Összes előzmény törlése', 'history-clear'))
  const entries = state.library[state.panel]
  if (!entries.length) {
    const empty = document.createElement('p')
    empty.className = 'panel-empty'
    empty.textContent = state.panel === 'bookmarks' ? 'Még nincs könyvjelződ.' : state.panel === 'history' ? 'Még nincs előzmény.' : 'Még nincs letöltés.'
    list.append(empty)
    return
  }
  for (const entry of entries) {
    const row = document.createElement('div')
    row.className = 'library-row'
    const title = document.createElement('div')
    title.className = 'row-title'
    title.textContent = 'name' in entry ? entry.name : entry.title
    const subtitle = document.createElement('div')
    subtitle.className = 'row-subtitle'
    subtitle.textContent = entry.url
    const footer = document.createElement('div')
    footer.className = 'row-footer'
    if ('status' in entry) {
      const status = document.createElement('span')
      const labels = { progressing: 'Letöltés folyamatban', completed: 'Kész', cancelled: 'Megszakítva', interrupted: 'Hiba miatt megszakadt' }
      status.textContent = entry.status === 'progressing' && entry.total > 0
        ? `${Math.round(entry.received / entry.total * 100)}% · ${formatBytes(entry.received)} / ${formatBytes(entry.total)}`
        : `${labels[entry.status]} · ${formatBytes(entry.received)}`
      footer.append(status)
      if (entry.status === 'progressing') footer.append(actionButton('Megszakítás', 'download-cancel', entry.id))
      else {
        if (entry.status === 'completed') footer.append(actionButton('Mappa', 'download-reveal', entry.id))
        footer.append(actionButton('Eltávolítás', 'download-remove', entry.id))
      }
    } else {
      const time = document.createElement('span')
      time.textContent = new Date('visitedAt' in entry ? entry.visitedAt : entry.createdAt).toLocaleString('hu-HU')
      footer.append(time)
      footer.append(actionButton('Megnyitás', 'open-entry', entry.id))
      footer.append(actionButton('Törlés', 'visitedAt' in entry ? 'history-remove' : 'bookmark-remove', entry.id))
    }
    if ('favicon' in entry) row.prepend(favicon(entry.favicon))
    row.append(title, subtitle, footer)
    list.append(row)
  }
}

function renderToolPopover() {
  const root = $('tool-popover')
  root.hidden = !state.toolPopover
  const activeSlider = root.querySelector<HTMLInputElement>('input[type="range"]')
  if (state.toolPopover === 'bass' && activeSlider && document.activeElement === activeSlider) return
  root.replaceChildren()
  if (!state.toolPopover) return
  const header = document.createElement('div')
  header.className = 'tool-popover-heading'
  const title = document.createElement('strong')
  title.textContent = state.toolPopover === 'certificate' ? 'Kapcsolat és tanúsítvány' : 'Bass Booster'
  const close = document.createElement('button')
  close.type = 'button'
  close.title = 'Bezárás'
  close.setAttribute('aria-label', 'Bezárás')
  close.append(icon('x'))
  close.addEventListener('click', () => command('tool-close'))
  header.append(title, close)
  root.append(header)
  if (state.toolPopover === 'certificate') {
    const certificate = state.certificate
    const summary = document.createElement('p')
    summary.className = `certificate-status ${certificate.status}`
    summary.textContent = certificate.status === 'secure' ? 'A kapcsolat tanúsítványa érvényes.' : certificate.status === 'error' ? `Tanúsítványhiba: ${certificate.error ?? 'ismeretlen hiba'}` : certificate.status === 'loading' ? 'A tanúsítvány adatainak betöltése…' : certificate.status === 'unavailable' ? 'A tanúsítvány adatai nem érhetők el.' : 'Ehhez az oldalhoz nincs HTTPS-tanúsítvány.'
    root.append(summary)
    const fields: [string, string | undefined][] = [
      ['Webhely', certificate.host], ['Alany', certificate.subject], ['Kibocsátó', certificate.issuer],
      ['Érvényes ettől', certificate.validFrom ? new Date(certificate.validFrom * 1000).toLocaleString('hu-HU') : undefined],
      ['Érvényes eddig', certificate.validTo ? new Date(certificate.validTo * 1000).toLocaleString('hu-HU') : undefined],
      ['Protokoll', certificate.protocol], ['Titkosítás', certificate.cipher],
    ]
    for (const [label, value] of fields) if (value) {
      const row = document.createElement('div')
      row.className = 'certificate-field'
      const caption = document.createElement('span')
      caption.textContent = label
      const content = document.createElement('strong')
      content.textContent = value
      row.append(caption, content)
      root.append(row)
    }
  } else {
    const tab = state.tabs.find(item => item.id === state.activeId)
    const description = document.createElement('p')
    description.className = 'bass-description'
    description.textContent = tab?.bassStatus === 'error' ? 'Egy lap hangfeldolgozása nem sikerült; ott a normál hang visszaállt.' : 'Mélyhangkiemelés a böngésző minden lapján'
    root.append(description)
    const presets = document.createElement('div')
    presets.className = 'bass-presets'
    const presetValues = [{ name: 'Tiszta', db: 4, frequency: 80 }, { name: 'Mély', db: 7, frequency: 95 }, { name: 'Erős', db: 10, frequency: 120 }]
    const selectedPreset = presetValues.find(preset => preset.db === state.globalBassDb && preset.frequency === state.globalBassFrequency)?.name ?? 'Egyéni'
    for (const preset of presetValues) {
      const button = document.createElement('button')
      button.type = 'button'; button.textContent = preset.name
      button.className = preset.name === selectedPreset ? 'selected' : ''
      button.addEventListener('click', () => command('bass-set', JSON.stringify({ db: preset.db, frequency: preset.frequency })))
      presets.append(button)
    }
    const custom = document.createElement('button')
    custom.type = 'button'; custom.textContent = 'Egyéni'; custom.disabled = true
    custom.className = selectedPreset === 'Egyéni' ? 'selected' : ''
    presets.append(custom)
    root.append(presets)
    const control = document.createElement('label')
    control.className = 'bass-control'
    const label = document.createElement('span')
    label.textContent = `Erősség · ${state.globalBassDb} dB${!state.globalBassDb ? ' · kikapcsolva' : ` · ${selectedPreset}`}`
    const slider = document.createElement('input')
    slider.type = 'range'; slider.min = '0'; slider.max = '12'; slider.step = '1'; slider.value = String(state.globalBassDb)
    slider.setAttribute('aria-label', 'Mélyhangkiemelés')
    slider.addEventListener('input', () => { label.textContent = `${slider.value} dB${slider.value === '0' ? ' · kikapcsolva' : ''}` })
    slider.addEventListener('change', () => command('bass-set', JSON.stringify({ db: Number(slider.value), frequency: state.globalBassFrequency })))
    slider.addEventListener('blur', () => renderToolPopover())
    control.append(label, slider)
    const frequencyControl = document.createElement('label')
    frequencyControl.className = 'bass-control'
    const frequencyLabel = document.createElement('span')
    frequencyLabel.textContent = `Basszusfrekvencia · ${state.globalBassFrequency} Hz`
    const frequencySlider = document.createElement('input')
    frequencySlider.type = 'range'; frequencySlider.min = '60'; frequencySlider.max = '160'; frequencySlider.step = '5'; frequencySlider.value = String(state.globalBassFrequency)
    frequencySlider.setAttribute('aria-label', 'Basszusfrekvencia')
    frequencySlider.addEventListener('input', () => { frequencyLabel.textContent = `Basszusfrekvencia · ${frequencySlider.value} Hz` })
    frequencySlider.addEventListener('change', () => command('bass-set', JSON.stringify({ db: state.globalBassDb, frequency: Number(frequencySlider.value) })))
    frequencyControl.append(frequencyLabel, frequencySlider)
    root.append(control, frequencyControl)
  }
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB` }

function renderDownloadConfirmation() {
  const pending = state.pendingDownload
  const root = $('download-confirm')
  root.hidden = !pending
  if (!pending) return
  $('download-confirm-name').textContent = pending.filename
  $('download-confirm-meta').textContent = `${pending.host} · ${pending.total > 0 ? formatBytes(pending.total) : 'ismeretlen méret'}`
  ;($('download-confirm-accept') as HTMLButtonElement).dataset.id = pending.id
  ;($('download-confirm-cancel') as HTMLButtonElement).dataset.id = pending.id
}

function render(next: State) {
  if (overlayMode === 'downloads') {
    const ids = new Set(next.sessionDownloadIds)
    state = { ...next, panel: 'downloads', library: { ...next.library, downloads: next.library.downloads.filter(entry => ids.has(entry.id)) } }
  } else if (overlayMode === 'panel' && overlayClosing && !next.panel) state = { ...next, panel: lastOverlayPanel }
  else state = next
  if (overlayMode === 'panel' && next.panel) { lastOverlayPanel = next.panel; overlayClosing = false; document.body.classList.remove('overlay-closing') }
  if (overlayMode === 'tool') { renderToolPopover(); renderIcons(); return }
  if (overlayMode === 'download-confirm') { renderDownloadConfirmation(); renderIcons(); return }
  if (overlayMode) { renderPanel(); renderIcons(); return }
  document.body.classList.toggle('fullscreen', state.fullscreenMode !== 'none')
  $('window-maximize').classList.toggle('restored', state.maximized)
  setIcon($('window-maximize'), state.maximized ? 'copy' : 'square')
  $('window-maximize').setAttribute('aria-label', state.maximized ? 'Visszaállítás' : 'Nagyítás')
  $('window-maximize').title = state.maximized ? 'Visszaállítás' : 'Nagyítás'
  if (state.panel !== 'settings') { homeModeDraft = null; homepageDraft = null; settingsError = '' }
  const active = state.tabs.find(tab => tab.id === state.activeId)
  const security = $('site-security')
  setIcon(security, state.certificate.status === 'secure' ? 'lock-keyhole' : state.certificate.status === 'error' || state.certificate.status === 'unavailable' ? 'triangle-alert' : 'globe')
  security.classList.toggle('secure', state.certificate.status === 'secure')
  security.classList.toggle('certificate-error', state.certificate.status === 'error')
  security.title = state.certificate.status === 'secure' ? 'Érvényes HTTPS-kapcsolat · részletek' : state.certificate.status === 'error' ? 'Tanúsítványhiba · részletek' : 'Kapcsolat adatai'
  $('show-bass').classList.toggle('bass-active', state.globalBassDb > 0)
  $('show-bass').classList.toggle('selected', state.toolPopover === 'bass')
  const activeChanged = renderedActiveId !== state.activeId
  renderedActiveId = state.activeId
  const previousTabPositions = new Map<string, DOMRect>()
  for (const [id, element] of tabElements) previousTabPositions.set(id, element.getBoundingClientRect())
  for (const [index, tab] of state.tabs.entries()) {
    let item = tabElements.get(tab.id)
    const isNew = !item
    if (!item) {
      item = document.createElement('div')
      item.dataset.entering = 'true'
      item.addEventListener('click', () => command('select', tab.id))
      item.addEventListener('auxclick', event => {
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        command('close', tab.id)
      })
      item.addEventListener('animationend', event => {
        if (event.animationName !== 'tab-enter') return
        if (item) { delete item.dataset.entering; item.classList.remove('entering') }
      })
      tabElements.set(tab.id, item)
    }
    item.className = `tab${tab.id === state.activeId ? ' active' : ''}${tab.loading ? ' loading' : ''}${tab.closing ? ' closing' : ''}${item.dataset.entering === 'true' ? ' entering' : ''}`
    item.setAttribute('aria-disabled', String(tab.closing))
    if (tab.closing && item.dataset.closeAcknowledged !== 'true') {
      item.dataset.closeAcknowledged = 'true'
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) command('finish-close', tab.id)
      else {
        const finish = (event: AnimationEvent) => {
          if (event.animationName !== 'tab-close') return
          item?.removeEventListener('animationend', finish)
          command('finish-close', tab.id)
        }
        item.addEventListener('animationend', finish)
      }
    }
    const previousIcon = item.querySelector<HTMLElement>('.favicon-wrap')
    let tabIcon = previousIcon
    const fallbackIcon = tab.url === 'skipy://home' ? 'house' : 'globe'
    if (!tabIcon || tabIcon.dataset.iconUrl !== (tab.favicon ?? '') || tabIcon.dataset.fallbackIcon !== fallbackIcon) {
      tabIcon = favicon(tab.favicon, fallbackIcon)
      tabIcon.dataset.iconUrl = tab.favicon ?? ''
      tabIcon.dataset.fallbackIcon = fallbackIcon
      if (previousIcon) previousIcon.replaceWith(tabIcon)
      else item.prepend(tabIcon)
    }
    let name = item.querySelector<HTMLElement>('.tab-name')
    if (!name) { name = document.createElement('span'); name.className = 'tab-name'; item.append(name) }
    name.textContent = tab.title || 'Új lap'
    let sound = item.querySelector<HTMLButtonElement>('.tab-sound')
    if (tab.audible || tab.muted) {
      if (!sound) {
        sound = document.createElement('button')
        sound.className = 'tab-sound'
        sound.type = 'button'
        sound.addEventListener('click', event => { event.stopPropagation(); command('toggle-mute', tab.id) })
        item.append(sound)
      }
      if (sound.dataset.muted !== String(tab.muted)) { sound.replaceChildren(icon(tab.muted ? 'volume-x' : 'volume-2')); sound.dataset.muted = String(tab.muted) }
      sound.title = tab.muted ? 'Lap hangjának visszakapcsolása' : 'Lap némítása'
      sound.setAttribute('aria-label', sound.title)
    } else sound?.remove()
    let close = item.querySelector<HTMLButtonElement>('.tab-close')
    if (!close) {
      close = document.createElement('button')
      close.className = 'tab-close'
      close.append(icon('x'))
      close.addEventListener('click', event => { event.stopPropagation(); command('close', tab.id) })
      item.append(close)
    }
    close.title = 'Lap bezárása'
    close.setAttribute('aria-label', `${tab.title} bezárása`)
    if (tabsElement.children[index] !== item) tabsElement.insertBefore(item, tabsElement.children[index] ?? null)
    if (isNew && matchMedia('(prefers-reduced-motion: reduce)').matches) { delete item.dataset.entering; item.classList.remove('entering') }
  }
  for (const [id, item] of tabElements) if (!state.tabs.some(tab => tab.id === id)) { item.remove(); tabElements.delete(id) }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) for (const [id, item] of tabElements) {
    const before = previousTabPositions.get(id)
    if (!before || item.classList.contains('closing')) continue
    const after = item.getBoundingClientRect()
    const dx = before.left - after.left
    if (Math.abs(dx) > 0.5) item.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' })
  }
  let add = tabsElement.querySelector<HTMLButtonElement>('.new-tab')
  if (!add) {
    add = document.createElement('button')
    add.className = 'new-tab'
    add.append(icon('plus'))
    add.title = 'Új lap'
    add.setAttribute('aria-label', 'Új lap')
    add.addEventListener('click', () => { command('new'); focusAddress() })
    tabsElement.append(add)
  }
  if (tabsElement.lastElementChild !== add) tabsElement.append(add)

  if (activeChanged || document.activeElement !== address) {
    address.value = active?.url === 'skipy://home' ? '' : active?.url ?? ''
    closeSuggestions(address)
  }
  updateProgress(active)
  ;($('back') as HTMLButtonElement).disabled = !active?.canGoBack
  ;($('forward') as HTMLButtonElement).disabled = !active?.canGoForward
  setIcon($('reload'), active?.loading ? 'x' : 'rotate-cw')
  const bookmarked = state.library.bookmarks.some(item => item.url === active?.url)
  setIcon($('bookmark-toggle'), bookmarked ? 'star' : 'bookmark')
  ;($('bookmark-toggle') as HTMLButtonElement).disabled = !active || !/^https?:\/\//i.test(active.url)
  $('bookmark-toggle').title = bookmarked ? 'Könyvjelző eltávolítása' : 'Könyvjelző hozzáadása'
  home.hidden = active?.url !== 'skipy://home'
  renderQuickLinks()
  updateDownloadsButton()
  if (suggestionState.has(address)) showSuggestions(address)
  if (suggestionState.has(homeSearch)) showSuggestions(homeSearch)
  document.title = `${active?.title ?? 'Új lap'} · Skipy Browser`
  renderIcons()
}

window.browser.onState(render)
window.browser.onOverlayClose(() => { if (overlayMode === 'panel') { overlayClosing = true; document.body.classList.add('overlay-closing') } })
window.browser.onDownloadLand(() => {
  const button = $('show-downloads')
  button.classList.remove('download-impact')
  void button.offsetWidth
  button.classList.add('download-impact')
  setTimeout(() => button.classList.remove('download-impact'), 550)
})
renderIcons()
window.browser.onFocusAddress(focusAddress)
void window.browser.command('state').then(result => { if (result && typeof result !== 'string') render(result) })

$('address-form').addEventListener('submit', event => { event.preventDefault(); closeSuggestions(address); command('navigate', address.value); address.blur() })
$('back').addEventListener('click', () => command('back'))
$('forward').addEventListener('click', () => command('forward'))
$('reload').addEventListener('click', () => command('reload'))
$('home').addEventListener('click', () => command('home'))
$('bookmark-toggle').addEventListener('click', () => command('bookmark-toggle'))
function openTool(kind: 'certificate' | 'bass', element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  command('tool', JSON.stringify({ kind, anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }))
}
$('site-security').addEventListener('click', () => openTool('certificate', $('site-security')))
$('show-bass').addEventListener('click', () => openTool('bass', $('show-bass')))
$('show-bookmarks').addEventListener('click', () => command('panel', 'bookmarks'))
$('show-history').addEventListener('click', () => command('panel', 'history'))
$('show-downloads').addEventListener('click', () => command('downloads-toggle'))
$('show-settings').addEventListener('click', () => command('panel', 'settings'))
$('show-privacy').addEventListener('click', () => command('panel', 'privacy'))
$('panel-close').addEventListener('click', () => command(overlayMode === 'downloads' ? 'downloads-close' : 'panel', overlayMode === 'downloads' ? undefined : 'close'))
window.addEventListener('resize', updateDownloadsButton)
$('window-minimize').addEventListener('click', () => command('window-minimize'))
$('window-maximize').addEventListener('click', () => command('window-maximize'))
$('window-close').addEventListener('click', () => command('window-close'))
$('download-confirm-accept').addEventListener('click', event => command('download-confirm', (event.currentTarget as HTMLButtonElement).dataset.id))
$('download-confirm-cancel').addEventListener('click', event => command('download-reject', (event.currentTarget as HTMLButtonElement).dataset.id))
window.addEventListener('keydown', event => {
  if (overlayMode === 'download-confirm' && event.key === 'Escape' && state.pendingDownload) command('download-reject', state.pendingDownload.id)
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    if (!home.hidden) { homeSearch.focus(); homeSearch.select() } else focusAddress()
  }
})
$('home-search-form').addEventListener('submit', event => {
  event.preventDefault()
  closeSuggestions(homeSearch)
  if (homeSearch.value.trim()) command('navigate', homeSearch.value)
  homeSearch.value = ''
})
$('quicklink-cancel').addEventListener('click', () => ($('quicklink-dialog') as HTMLDialogElement).close())
$('quicklink-form').addEventListener('submit', event => {
  event.preventDefault()
  const id = ($('quicklink-id') as HTMLInputElement).value
  const title = ($('quicklink-title') as HTMLInputElement).value
  const url = ($('quicklink-url') as HTMLInputElement).value
  void window.browser.command('quicklink-save', JSON.stringify({ id: id || undefined, title, url })).then(result => {
    if (typeof result === 'string') { $('quicklink-error').textContent = result; command('notice-error', result) }
    else ($('quicklink-dialog') as HTMLDialogElement).close()
  })
})
wireSuggestions(address)
wireSuggestions(homeSearch)
