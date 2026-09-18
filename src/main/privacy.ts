import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDomain } from 'tldts'

type RequestRow = { site: string; host: string; count: number; blocked: number; lastSeen: number }
type PrivacyData = { secret: string; rules: Record<string, string[]>; disabledSites: string[]; requests: RequestRow[] }
const MAX_ROWS = 2000
let filePath = ''
let data: PrivacyData = { secret: randomBytes(32).toString('hex'), rules: {}, disabledSites: [], requests: [] }
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function siteForHost(host: string): string {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return getDomain(normalized, { allowPrivateDomains: true }) || normalized
}
export function hostForUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null
  } catch { return null }
}
export function siteForUrl(url: string): string | null {
  const host = hostForUrl(url)
  return host ? siteForHost(host) : null
}

export function loadPrivacy() {
  const dir = path.join(app.getPath('userData'), 'skipy-data')
  fs.mkdirSync(dir, { recursive: true })
  filePath = path.join(dir, 'privacy.json')
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Partial<PrivacyData>
      if (typeof record.secret === 'string' && /^[0-9a-f]{64}$/.test(record.secret)) data.secret = record.secret
      if (record.rules && typeof record.rules === 'object') {
        for (const [site, hosts] of Object.entries(record.rules)) {
          if (siteForHost(site) === site && Array.isArray(hosts)) data.rules[site] = hosts.filter(host => typeof host === 'string' && hostForUrl(`https://${host}/`) === host)
        }
      }
      if (Array.isArray(record.disabledSites)) data.disabledSites = record.disabledSites.filter(site => typeof site === 'string' && siteForHost(site) === site)
      if (Array.isArray(record.requests)) data.requests = record.requests.filter(validRow).slice(0, MAX_ROWS)
    }
  } catch { /* Missing or damaged file starts with safe defaults. */ }
  flushPrivacy()
}
function validRow(value: unknown): value is RequestRow {
  const row = value as RequestRow
  return !!row && typeof row.site === 'string' && typeof row.host === 'string' && typeof row.count === 'number' && typeof row.blocked === 'number' && typeof row.lastSeen === 'number'
}
export function flushPrivacy() {
  if (!filePath) return
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const temporary = `${filePath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(temporary, filePath)
}
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(flushPrivacy, 1000)
}
export function secret() { return data.secret }
export function disabledSites() { return data.disabledSites }
export function isFingerprintEnabled(site: string) { return !data.disabledSites.includes(site) }
export function setFingerprintEnabled(site: string, enabled: boolean) {
  data.disabledSites = data.disabledSites.filter(value => value !== site)
  if (!enabled) data.disabledSites.push(site)
  flushPrivacy()
}
export function isBlocked(site: string, host: string) { return data.rules[site]?.includes(host) ?? false }
export function toggleBlock(site: string, host: string) {
  const hosts = data.rules[site] ?? []
  data.rules[site] = hosts.includes(host) ? hosts.filter(value => value !== host) : [...hosts, host]
  flushPrivacy()
}
export function requestSummary(site: string) {
  return {
    site,
    rows: data.requests.filter(row => row.site === site).sort((a, b) => b.lastSeen - a.lastSeen).map(row => ({ ...row, blockedNow: isBlocked(site, row.host) })),
    blockedHosts: data.rules[site] ?? [],
    fingerprintEnabled: isFingerprintEnabled(site),
  }
}
export function recordRequest(site: string, host: string, blocked: boolean) {
  let row = data.requests.find(item => item.site === site && item.host === host)
  if (!row) {
    row = { site, host, count: 0, blocked: 0, lastSeen: 0 }
    data.requests.push(row)
  }
  row.count++
  if (blocked) row.blocked++
  row.lastSeen = Date.now()
  if (data.requests.length > MAX_ROWS) {
    data.requests.sort((a, b) => b.lastSeen - a.lastSeen)
    data.requests.length = MAX_ROWS
  }
  scheduleSave()
}
export function clearRequests(site?: string) {
  data.requests = site ? data.requests.filter(row => row.site !== site) : []
  flushPrivacy()
}
