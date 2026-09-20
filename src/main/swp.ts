import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export type SwpPermission = 'camera' | 'microphone' | 'notifications'
export type PermissionDecision = 'allow' | 'block'
type SwpData = {
  version: 1
  adblockExceptions: string[]
  permissions: Record<string, Partial<Record<SwpPermission, PermissionDecision>>>
  popups: Record<string, PermissionDecision>
  clearOnExit: string[]
  listUpdatedAt: number
  listStatus: 'bundled' | 'updated' | 'error'
  blockedTotal: number
  popupBlockedTotal: number
  downloadedRules: string[]
  cosmeticRules: string[]
}

const bundledHosts = [
  'doubleclick.net','googlesyndication.com','googleadservices.com','adservice.google.com','amazon-adsystem.com','adsystem.com','adnxs.com','criteo.com','criteo.net','taboola.com','outbrain.com','scorecardresearch.com','quantserve.com','hotjar.com','mouseflow.com','mixpanel.com','segment.io','segment.com','appsflyer.com','branch.io','mathtag.com','rubiconproject.com','pubmatic.com','openx.net','yieldmo.com','moatads.com','advertising.com','adsrvr.org','demdex.net','2mdn.net','google-analytics.com','googletagmanager.com'
]
const bundledCosmetic = ['.adsbygoogle','[id^="google_ads_"]','[class*=" ad-container"]','[class^="ad-container"]','.advertisement','.sponsored-ad']
let filePath = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let data: SwpData = { version: 1, adblockExceptions: [], permissions: {}, popups: {}, clearOnExit: [], listUpdatedAt: 0, listStatus: 'bundled', blockedTotal: 0, popupBlockedTotal: 0, downloadedRules: [], cosmeticRules: [] }
let ruleHosts = new Set(bundledHosts)

export function loadSwp() {
  const dir = path.join(app.getPath('userData'), 'skipy-data'); fs.mkdirSync(dir, { recursive: true }); filePath = path.join(dir, 'swp.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<SwpData>
    data = { ...data, ...parsed, version: 1, adblockExceptions: stringArray(parsed.adblockExceptions), clearOnExit: stringArray(parsed.clearOnExit), downloadedRules: stringArray(parsed.downloadedRules), cosmeticRules: stringArray(parsed.cosmeticRules), permissions: parsed.permissions && typeof parsed.permissions === 'object' ? parsed.permissions : {}, popups: parsed.popups && typeof parsed.popups === 'object' ? parsed.popups : {} }
  } catch { /* First start uses bundled protection. */ }
  rebuildRules()
}
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100000) : [] }
function rebuildRules() { ruleHosts = new Set([...bundledHosts, ...data.downloadedRules]) }
function scheduleSave(delay = 180) { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; void flushSwp() }, delay) }
export async function flushSwp() { if (!filePath) return; if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }; const tmp = `${filePath}.tmp`; await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2)); await fs.promises.rename(tmp, filePath) }
export function swpData() { return data }
export function permissionFor(site: string, permission: SwpPermission) { return data.permissions[site]?.[permission] }
export function setPermission(site: string, permission: SwpPermission, decision?: PermissionDecision) { data.permissions[site] ??= {}; if (decision) data.permissions[site][permission] = decision; else delete data.permissions[site][permission]; scheduleSave() }
export function popupFor(site: string) { return data.popups[site] }
export function setPopup(site: string, decision?: PermissionDecision) { if (decision) data.popups[site] = decision; else delete data.popups[site]; scheduleSave() }
export function adblockEnabled(site: string) { return !data.adblockExceptions.includes(site) }
export function toggleAdblock(site: string) { const i = data.adblockExceptions.indexOf(site); if (i >= 0) data.adblockExceptions.splice(i, 1); else data.adblockExceptions.push(site); scheduleSave() }
export function clearOnExit(site: string) { return data.clearOnExit.includes(site) }
export function toggleClearOnExit(site: string) { const i = data.clearOnExit.indexOf(site); if (i >= 0) data.clearOnExit.splice(i, 1); else data.clearOnExit.push(site); scheduleSave() }
export function isAdRequest(site: string, host: string) { if (!adblockEnabled(site) || !host || host === site) return false; for (const rule of ruleHosts) if (host === rule || host.endsWith(`.${rule}`)) return true; return false }
export function recordAdBlocked() { data.blockedTotal++; scheduleSave(2500) }
export function recordPopupBlocked() { data.popupBlockedTotal++; scheduleSave(2500) }
export function cosmeticCss() { return [...bundledCosmetic, ...data.cosmeticRules].slice(0, 4000).join(',') + '{display:none!important}' }

function parseLists(text: string) {
  const hosts = new Set<string>(), cosmetic = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line[0] === '!' || line.startsWith('@@')) continue
    if (line.startsWith('##')) { const selector = line.slice(2); if (selector && selector.length < 300 && !/[{}]|:-abp-|:has\(/.test(selector)) cosmetic.add(selector); continue }
    const match = /^\|\|([a-z0-9.-]+)\^/i.exec(line)
    if (match) hosts.add(match[1].toLowerCase().replace(/^www\./, ''))
  }
  return { hosts: [...hosts].slice(0, 90000), cosmetic: [...cosmetic].slice(0, 10000) }
}
export async function updateLists(force = false) {
  if (!force && Date.now() - data.listUpdatedAt < 7 * 86400000) return false
  try {
    const signal = AbortSignal.timeout(15000)
    const urls = ['https://easylist.to/easylist/easylist.txt', 'https://easylist.to/easylist/easyprivacy.txt']
    const responses = await Promise.all(urls.map(url => net.fetch(url, { signal, cache: 'no-store' })))
    if (responses.some(response => !response.ok)) throw new Error('Filter list download failed')
    const parsed = parseLists((await Promise.all(responses.map(response => response.text()))).join('\n'))
    if (parsed.hosts.length < 1000) throw new Error('Filter list is incomplete')
    data.downloadedRules = parsed.hosts; data.cosmeticRules = parsed.cosmetic; data.listUpdatedAt = Date.now(); data.listStatus = 'updated'; rebuildRules(); scheduleSave(); return true
  } catch { data.listStatus = 'error'; scheduleSave(); return false }
}
