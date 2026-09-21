/* Verifies private mode against the real Electron main process. */
const { app, BrowserWindow, webContents } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skipy-private-smoke-'))
app.setPath('appData', path.join(root, 'appdata'))
process.env.LOCALAPPDATA = path.join(root, 'local')
process.argv.push('--skipy-window=smoke-private', '--skipy-private')
const extensionPath = path.join(root, 'extension')
fs.mkdirSync(extensionPath, { recursive: true })
fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Skipy Smoke Extension', version: '1.0.0' }))
const privateData = path.join(app.getPath('temp'), 'skipy-private-smoke-private', 'profile', 'skipy-data')
fs.mkdirSync(privateData, { recursive: true })
fs.writeFileSync(path.join(privateData, 'library.json'), JSON.stringify({ bookmarks: [], history: [], quickLinks: [], downloads: [{ id: 'old-download', name: 'pelda.zip', path: 'C:\\Temp\\pelda.zip', url: 'https://example.com/pelda.zip', received: 100, total: 100, status: 'completed', startedAt: Date.now() }], extensions: [{ id: 'pending', name: 'Skipy Smoke Extension', path: extensionPath, enabled: true }], settings: { searchEngine: 'google', homepage: 'skipy', developerMode: false } }))
app.on('browser-window-created', (_event, win) => win.hide())

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label, timeout = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await pause(50) }
  throw new Error(`Timeout: ${label}`)
}

let server
async function run() {
  server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Privát próba</title><h1>Privát próba</h1>') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  require('../dist-main/main.js')
  const win = await until(() => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('index.html')), 'private window')
  await until(() => win.webContents.executeJavaScript('!!window.browser').catch(() => false), 'private bridge')
  const command = async (action, value) => {
    const result = await win.webContents.executeJavaScript(`window.browser.command(${JSON.stringify(action)},${JSON.stringify(value)}).then(value=>value===undefined?'__VOID__':JSON.stringify(value))`)
    return result === '__VOID__' ? undefined : JSON.parse(result)
  }
  let state = await command('state')
  assert.equal(state.privateMode, true)
  assert.equal(await win.webContents.executeJavaScript("!document.getElementById('private-indicator').hidden"), true)
  assert.equal(await win.webContents.executeJavaScript("!!document.getElementById('new-window')&&!!document.getElementById('new-private-window')"), true)
  assert.equal(await win.webContents.executeJavaScript("!!document.getElementById('create-menu')&&!!document.getElementById('new-tab')"), true)
  await until(async () => (await command('state')).library.extensions[0]?.enabled, 'unpacked extension loaded')
  state = await command('state')
  assert.equal(state.library.downloads[0].name, 'pelda.zip')
  await command('panel', 'settings')
  const settingsOverlay = await until(() => webContents.getAllWebContents().find(contents => contents.getURL().includes('overlay=panel')), 'settings overlay')
  await until(() => settingsOverlay.executeJavaScript("document.querySelectorAll('.settings-data-actions button').length===4").catch(() => false), 'data management actions')
  const address = `http://127.0.0.1:${server.address().port}/private`
  await command('navigate', address)
  await until(async () => (await command('state')).tabs.some(tab => tab.url === address && !tab.loading), 'private navigation')
  state = await command('state')
  assert.equal(state.library.history.length, 0)
  assert.equal(state.pageSafety.level, 'warning')
  assert.ok(state.pageSafety.reasons.some(reason => reason.includes('HTTPS')))
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('address').nextElementSibling?.id"), 'bookmark-toggle')
  await command('bookmark-toggle')
  await until(async () => (await command('state')).library.bookmarks[0]?.folder === 'Kedvencek', 'favorite bookmark folder')
  const privateTabId = state.activeId
  await command('new')
  await command('hibernate-tab', privateTabId)
  await until(async () => (await command('state')).tabs.find(tab => tab.id === privateTabId)?.hibernated, 'manual tab hibernation')
  await command('select', privateTabId)
  await until(async () => { const current=await command('state');return current.activeId===privateTabId&&!current.tabs.find(tab=>tab.id===privateTabId)?.hibernated }, 'hibernated tab wake')
  console.log('PRIVATE_SMOKE_OK isolated profile, no history, window controls present')
}

const watchdog = setTimeout(() => { console.error('Private smoke exceeded 30 seconds'); app.exit(1) }, 30000)
run().then(() => { clearTimeout(watchdog); server.close(); app.quit() }).catch(error => { clearTimeout(watchdog); console.error(error); server?.close(); app.exit(1) })
