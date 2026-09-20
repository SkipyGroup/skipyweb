import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type Bookmark = { id: string; title: string; url: string; createdAt: number; favicon?: string }
export type HistoryEntry = { id: string; title: string; url: string; visitedAt: number; favicon?: string }
export type DownloadEntry = { id: string; name: string; path: string; url: string; received: number; total: number; status: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; startedAt: number }
export type Settings = { searchEngine: 'google' | 'duckduckgo' | 'bing'; homepage: string; developerMode: boolean }
export type QuickLink = { id: string; title: string; url: string }
export type Library = { bookmarks: Bookmark[]; history: HistoryEntry[]; downloads: DownloadEntry[]; quickLinks: QuickLink[]; settings: Settings }

let library: Library = { bookmarks: [], history: [], downloads: [], quickLinks: [], settings: { searchEngine: 'google', homepage: 'skipy', developerMode: false } }
let filePath = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let writeChain: Promise<void> = Promise.resolve()

export function getLibrary(): Library { return library }

export function loadLibrary() {
  const dir = path.join(app.getPath('userData'), 'skipy-data')
  fs.mkdirSync(dir, { recursive: true })
  filePath = path.join(dir, 'library.json')
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (data && typeof data === 'object') {
      const record = data as Record<string, unknown>
      library = {
        bookmarks: Array.isArray(record.bookmarks) ? record.bookmarks.filter(validBookmark) : [],
        history: Array.isArray(record.history) ? record.history.filter(validHistory) : [],
        downloads: Array.isArray(record.downloads) ? record.downloads.filter(validDownload).map((entry: DownloadEntry) => ({ ...entry, status: entry.status === 'progressing' ? 'interrupted' as const : entry.status })) : [],
        quickLinks: Array.isArray(record.quickLinks) ? record.quickLinks.filter(validQuickLink).slice(0, 6) : [],
        settings: validSettings(record.settings) ? { ...record.settings, developerMode: record.settings.developerMode === true } : { searchEngine: 'google', homepage: 'skipy', developerMode: false },
      }
    }
  } catch { /* A missing or damaged library starts empty. */ }
}
function validQuickLink(value: unknown): value is QuickLink {
  if (!value || typeof value !== 'object') return false
  const item = value as QuickLink
  return typeof item.id === 'string' && item.id.length > 0 && typeof item.title === 'string' && item.title.trim().length > 0 && item.title.length <= 60 && validFavicon(item.url)
}

function validBookmark(value: unknown): value is Bookmark {
  const item = value as Bookmark
  return !!item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string' && /^https?:\/\//.test(item.url) && typeof item.createdAt === 'number' && (item.favicon === undefined || validFavicon(item.favicon))
}
function validHistory(value: unknown): value is HistoryEntry {
  const item = value as HistoryEntry
  return !!item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string' && /^https?:\/\//.test(item.url) && typeof item.visitedAt === 'number' && (item.favicon === undefined || validFavicon(item.favicon))
}
export function validFavicon(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
function validSettings(value: unknown): value is Settings {
  if (!value || typeof value !== 'object') return false
  const settings = value as Settings
  return ['google', 'duckduckgo', 'bing'].includes(settings.searchEngine) && (settings.homepage === 'skipy' || validFavicon(settings.homepage))
}
function validDownload(value: unknown): value is DownloadEntry {
  const item = value as DownloadEntry
  return !!item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.url === 'string' && typeof item.received === 'number' && typeof item.total === 'number' && ['progressing', 'completed', 'cancelled', 'interrupted'].includes(item.status) && typeof item.startedAt === 'number'
}

export function saveLibrary() {
  if (!filePath) return
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; void flushLibrary().catch(() => undefined) }, 180)
}

export function flushLibrary(): Promise<void> {
  if (!filePath) return writeChain
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const snapshot = JSON.stringify(library, null, 2)
  const temporary = `${filePath}.tmp`
  writeChain = writeChain.catch(() => undefined).then(async () => {
    await fs.promises.writeFile(temporary, snapshot, 'utf8')
    await fs.promises.rename(temporary, filePath)
  })
  return writeChain
}

export function id() { return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}` }
