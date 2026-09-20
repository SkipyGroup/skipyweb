import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { SDT_WORLD_ID, sdtPageScript, type SdtPageCommand, type SdtPageEvent, type SdtPageReply } from './sdt-page'
import type { SdtSelection, SdtState, SdtStep, SdtStepResult } from './sdt-types'

type Target = { id: string; site: string; url: string; contents: WebContents }
type Snapshot = Pick<SdtState, 'mode' | 'selection' | 'draft' | 'results' | 'message'>

class Cancelled extends Error {}

export class SdtController {
  private target: Target | null = null
  private mode: SdtState['mode'] = 'idle'
  private selection: SdtSelection | null = null
  private draft: SdtStep[] = []
  private results: SdtStepResult[] = []
  private message = ''
  private epoch = 0
  private token: string | null = null
  private timer: NodeJS.Timeout | null = null
  private lastRecordedAt = 0
  private draftSite: string | null = null
  private navigationPending = false
  private navigationSerial = 0
  private navigationFlush: Promise<void> = Promise.resolve()
  private readonly bindingName = `__skipySdt_${randomUUID().replace(/-/g, '')}`
  private readonly bindingReady = new WeakSet<WebContents>()
  private readonly seenEvents = new Set<string>()
  private boundContents: WebContents | null = null
  private disposed = false

  constructor(private readonly onChange: () => void) {}

  private readonly onDebuggerMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (method !== 'Runtime.bindingCalled' || params.name !== this.bindingName || typeof params.payload !== 'string' || params.payload.length > 15000) return
    try {
      const payload = JSON.parse(params.payload) as { token?: unknown; event?: unknown }
      const event = payload.event as Extract<SdtPageEvent, { kind: 'step' }> | undefined
      if (payload.token !== this.token || !event || event.kind !== 'step' || typeof event.eventId !== 'string' || event.eventId.length > 100 || !Number.isFinite(event.at) || !event.step || !['click', 'input'].includes(event.step.kind)) return
      if (typeof event.step.selector !== 'string' || !event.step.selector || event.step.selector.length > 2048) return
      if (event.step.value !== undefined && (typeof event.step.value !== 'string' || event.step.value.length > 10000)) return
      this.consume([event]); this.changed()
    } catch { /* Ignore malformed page binding messages. */ }
  }

  private bindDebugger(contents: WebContents | null) {
    if (this.boundContents === contents) return
    if (this.boundContents && !this.boundContents.isDestroyed()) this.boundContents.debugger.removeListener('message', this.onDebuggerMessage)
    this.boundContents = contents
    if (contents && !contents.isDestroyed()) contents.debugger.on('message', this.onDebuggerMessage)
  }

  bind(target: Target | null): void {
    const previous = this.target
    if (!this.navigationPending && previous?.id === target?.id && previous?.url === target?.url && previous?.contents === target?.contents) return
    if (previous && target && previous.id === target.id && previous.contents === target.contents && previous.site === target.site) {
      const urlChanged = previous.url !== target.url
      previous.url = target.url
      this.navigationPending = false
      if (this.mode === 'recording') void this.resumeRecording(this.navigationSerial, this.epoch, previous, urlChanged)
      this.changed()
      return
    }
    const changed = previous !== null && this.mode !== 'idle'
    void this.stop(changed ? 'A lap vagy a dokumentum változása leállította az SDT műveletet.' : undefined)
    this.target = target
    this.bindDebugger(target?.contents ?? null)
    this.navigationPending = false
    this.selection = null
    // Keep the captured draft through navigation's temporary null target so a
    // click that leaves the document can still be reviewed and saved.
    if (target && this.draftSite !== target.site) {
      this.draftSite = target.site; this.draft = []; this.results = []; this.message = ''
    }
    this.changed()
  }

  snapshot(): Snapshot {
    return {
      mode: this.mode, selection: this.selection ? { ...this.selection, colors: this.selection.colors.map(color => ({ ...color })) } : null,
      draft: this.draft.map(step => ({ ...step })), results: this.results.map(result => ({ ...result })), message: this.message,
    }
  }

  clearMessage(): void {
    if (this.mode !== 'idle' || !this.message) return
    this.message = ''
    this.changed()
  }

  private changed() { if (!this.disposed) this.onChange() }

  private requireTarget(): Target {
    const target = this.target
    if (this.disposed || !target || target.contents.isDestroyed() || !/^https?:\/\//i.test(target.url)) throw new Error('Az SDT használatához nyiss meg egy HTTP(S) weboldalt.')
    return target
  }

  private assertCurrent(epoch: number, target: Target) {
    if (epoch !== this.epoch || this.disposed || this.target !== target || target.contents.isDestroyed()) throw new Cancelled('A művelet leállt.')
  }

  documentNavigation(tabId: string): void {
    const target = this.target
    if (!target || target.id !== tabId || this.mode === 'idle') return
    if (this.mode === 'picking') {
      void this.stop('A navigáció megszakította az elem kiválasztását.')
      return
    }
    this.navigationPending = true
    const serial = ++this.navigationSerial
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.mode === 'recording' && this.token) {
      const token = this.token
      this.navigationFlush = this.page(target, { kind: 'poll', token }, 350).then(reply => {
        if (serial === this.navigationSerial) this.consume(reply.events || [])
      }).catch(() => undefined)
    }
    this.message = 'Az új útvonal betöltése folyamatban…'
    this.changed()
  }

  private async page(target: Target, command: SdtPageCommand, timeoutMs = 5000): Promise<SdtPageReply> {
    if (target.contents.isDestroyed()) throw new Error('A lap már bezárult.')
    let timeout: NodeJS.Timeout | undefined
    try {
      const reply: SdtPageReply = await Promise.race([
        target.contents.executeJavaScriptInIsolatedWorld(SDT_WORLD_ID, [{ code: sdtPageScript(command) }]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Az oldal nem válaszolt az SDT kérésére.')), timeoutMs) }),
      ])
      if (!reply || typeof reply !== 'object') throw new Error('Az oldal nem adott érvényes SDT-választ.')
      if (reply.error) throw new Error(reply.error)
      return reply
    } finally { if (timeout) clearTimeout(timeout) }
  }

  private async install(target: Target, token: string, mode: 'picking' | 'recording') {
    let binding: string | undefined
    if (mode === 'recording' && target.contents.debugger.isAttached()) {
      try {
        if (!this.bindingReady.has(target.contents)) {
          await target.contents.debugger.sendCommand('Runtime.enable')
          await target.contents.debugger.sendCommand('Runtime.addBinding', { name: this.bindingName })
          this.bindingReady.add(target.contents)
        }
        binding = this.bindingName
      } catch { /* The regular isolated-world poller remains available. */ }
    }
    return this.page(target, { kind: 'install', token, mode, ...(binding ? { binding } : {}) })
  }

  private async begin(mode: 'picking' | 'recording') {
    const target = this.requireTarget()
    await this.stop()
    if (this.target !== target || this.disposed) throw new Error('Az aktív lap megváltozott.')
    const epoch = ++this.epoch, token = randomUUID()
    this.token = token; this.mode = mode; this.message = ''
    if (mode === 'picking') this.selection = null
    if (mode === 'recording') {
      this.draft = [{ id: randomUUID(), kind: 'url', value: target.url }]
      this.results = []; this.lastRecordedAt = Date.now()
    }
    this.changed()
    try {
      await this.install(target, token, mode)
      this.assertCurrent(epoch, target)
      target.contents.focus()
      this.message = mode === 'picking' ? 'Kattints egy elemre a színei kiválasztásához. Esc: mégse.' : 'A rögzítés fut. Az Esc vagy a Leállítás befejezi.'
      this.changed(); this.schedulePoll(epoch, target, token)
    } catch (error) {
      if (error instanceof Cancelled || epoch !== this.epoch) return
      await this.stop(error instanceof Error ? error.message : 'Az SDT nem indítható.')
      throw error
    }
  }

  startPicking(): Promise<void> { return this.begin('picking') }
  startRecording(): Promise<void> { return this.begin('recording') }

  private schedulePoll(epoch: number, target: Target, token: string) {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.poll(epoch, target, token)
    }, 120)
  }

  private async resumeRecording(serial: number, epoch: number, target: Target, urlChanged: boolean) {
    await this.navigationFlush
    if (serial !== this.navigationSerial || epoch !== this.epoch || this.mode !== 'recording' || this.target !== target || this.navigationPending) return
    if (urlChanged && this.draft.length < 100) {
      const last = this.draft[this.draft.length - 1]
      if (last?.kind !== 'url' || last.value !== target.url) this.draft.push({ id: randomUUID(), kind: 'url', value: target.url })
      this.lastRecordedAt = Date.now()
    }
    if (this.draft.length >= 100) { await this.stop('Elérted a tesztenkénti 100 lépéses korlátot.'); return }
    const token = randomUUID()
    this.token = token
    try {
      await this.install(target, token, 'recording')
      if (serial !== this.navigationSerial || epoch !== this.epoch || this.mode !== 'recording' || this.target !== target || this.navigationPending) return
      this.message = `Rögzítés folytatása: ${new URL(target.url).pathname || '/'}`
      this.changed()
      this.schedulePoll(epoch, target, token)
    } catch (error) {
      if (serial === this.navigationSerial && epoch === this.epoch) await this.stop(error instanceof Error ? error.message : 'A rögzítés nem folytatható az új útvonalon.')
    }
  }

  private async poll(epoch: number, target: Target, token: string) {
    try {
      this.assertCurrent(epoch, target)
      const reply = await this.page(target, { kind: 'poll', token })
      this.assertCurrent(epoch, target)
      const limit = this.consume(reply.events || [])
      if (limit) { await this.stop('Elérted a tesztenkénti 100 lépéses korlátot.'); return }
      if (!reply.alive) {
        this.mode = 'idle'; this.token = null; this.epoch++; this.changed(); return
      }
      if (reply.events?.length) this.changed()
      this.schedulePoll(epoch, target, token)
    } catch (error) {
      if (error instanceof Cancelled || epoch !== this.epoch) return
      await this.stop(error instanceof Error ? error.message : 'Az oldali SDT-kapcsolat megszakadt.')
    }
  }

  private consume(events: SdtPageEvent[]): boolean {
    for (const event of events) {
      if (event.kind === 'selection') this.selection = event.selection
      else if (event.kind === 'message' || event.kind === 'stopped') this.message = event.message
      else if (event.kind === 'step') {
        if (this.seenEvents.has(event.eventId)) continue
        this.seenEvents.add(event.eventId)
        if (this.seenEvents.size > 300) this.seenEvents.delete(this.seenEvents.values().next().value!)
        const last = this.draft[this.draft.length - 1]
        if (event.step.kind === 'input' && last?.kind === 'input' && last.selector === event.step.selector) {
          last.value = event.step.value; this.lastRecordedAt = event.at; continue
        }
        if (this.draft.length >= 100) return true
        const gap = event.at - this.lastRecordedAt
        if (gap >= 1000 && this.draft.length < 99) this.draft.push({ id: randomUUID(), kind: 'wait', ms: Math.min(10000, Math.round(gap / 100) * 100) })
        this.draft.push({ ...event.step, id: randomUUID() }); this.lastRecordedAt = event.at
      }
    }
    return this.draft.length >= 100
  }

  async stop(reason?: string): Promise<void> {
    const target = this.target, token = this.token, mode = this.mode
    const epoch = ++this.epoch
    this.token = null; this.mode = 'idle'
    this.navigationPending = false
    this.navigationSerial++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const result of this.results) if (result.status === 'running') { result.status = 'cancelled'; result.message = reason || 'A futtatás leállt.' }
    if (reason) this.message = reason
    this.changed()
    if (target && token && !target.contents.isDestroyed()) {
      try {
        const reply = await this.page(target, { kind: 'stop', token })
        if (epoch === this.epoch && this.draftSite === target.site) {
          if (mode === 'recording' || mode === 'picking') this.consume(reply.events || [])
          if (reason) this.message = reason
          else if (mode === 'recording') this.message = 'A rögzítés leállt. A lépések szerkeszthetők és menthetők.'
          this.changed()
        }
      } catch { /* Navigation may already have destroyed the isolated world. */ }
    }
  }

  setDraft(steps: SdtStep[]): void {
    if (this.mode !== 'idle') throw new Error('Szerkesztés előtt állítsd le az SDT műveletet.')
    this.validateSteps(steps)
    this.draft = steps.map(step => ({ ...step })); this.results = []; this.message = ''; this.changed()
  }

  private validateSteps(steps: SdtStep[]) {
    if (!Array.isArray(steps) || steps.length > 100) throw new Error('Legfeljebb 100 tesztlépés engedélyezett.')
    const ids = new Set<string>()
    for (const step of steps) {
      if (!step || typeof step.id !== 'string' || !step.id || ids.has(step.id) || !['click', 'input', 'wait', 'url'].includes(step.kind)) throw new Error('Érvénytelen tesztlépés.')
      ids.add(step.id)
      if ((step.kind === 'click' || step.kind === 'input') && (typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 2048)) throw new Error('A kattintás és bevitel érvényes CSS-lokátort igényel.')
      if (step.value !== undefined && (typeof step.value !== 'string' || step.value.length > 10000)) throw new Error('A tesztlépés értéke legfeljebb 10 000 karakter lehet.')
      if (step.kind === 'wait' && (!Number.isFinite(step.ms) || step.ms! < 0 || step.ms! > 30000)) throw new Error('A várakozás 0–30 000 ms lehet.')
      if (step.kind === 'url') {
        try { const url = new URL(step.value || ''); if (!['http:', 'https:'].includes(url.protocol)) throw new Error() }
        catch { throw new Error('Az URL-ellenőrzéshez teljes HTTP(S) cím szükséges.') }
      }
    }
  }

  private async pause(ms: number, epoch: number, target: Target) {
    const end = Date.now() + ms
    do {
      this.assertCurrent(epoch, target)
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(80, Math.max(0, end - Date.now()))))
    } while (Date.now() < end)
    this.assertCurrent(epoch, target)
  }

  private async waitForDocument(epoch: number, target: Target) {
    const end = Date.now() + 20000
    while (this.navigationPending || target.contents.isLoadingMainFrame()) {
      this.assertCurrent(epoch, target)
      if (Date.now() >= end) throw new Error('Az új útvonal nem töltődött be 20 másodpercen belül.')
      await new Promise<void>(resolve => setTimeout(resolve, 80))
    }
    this.assertCurrent(epoch, target)
  }

  private async waitForElement(target: Target, step: SdtStep, epoch: number): Promise<SdtPageReply> {
    const end = Date.now() + 5000
    let error: Error = new Error('Az elem nem található.')
    do {
      this.assertCurrent(epoch, target)
      try {
        const point = await this.page(target, { kind: 'locate', selector: step.selector! })
        this.assertCurrent(epoch, target); return point
      } catch (failure) {
        if (failure instanceof Cancelled) throw failure
        error = failure instanceof Error ? failure : new Error('Az elem nem található.')
        // Ambiguous or invalid selectors cannot become a safe target by falling back to coordinates.
        if (/több elemre|Érvénytelen|Hiányzó|keret/.test(error.message)) throw error
      }
      await this.pause(Math.min(120, Math.max(0, end - Date.now())), epoch, target)
    } while (Date.now() < end)
    throw error
  }

  async run(steps: SdtStep[]): Promise<void> {
    const target = this.requireTarget()
    this.validateSteps(steps)
    if (!steps.length) throw new Error('A teszt nem tartalmaz lépéseket.')
    await this.stop()
    if (this.target !== target || this.disposed) throw new Error('Az aktív lap megváltozott.')
    const epoch = ++this.epoch
    this.mode = 'running'; this.results = []; this.message = 'A teszt fut. Bármikor leállítható.'
    const copy = steps.map(step => ({ ...step }))
    const startUrlIndex = copy.findIndex(step => step.kind === 'url')
    this.draft = copy; this.changed()
    try {
      for (const [index, step] of copy.entries()) {
        this.assertCurrent(epoch, target)
        await this.waitForDocument(epoch, target)
        const result: SdtStepResult = { id: step.id, status: 'running' }
        this.results.push(result); this.changed()
        if (step.kind === 'wait') await this.pause(step.ms!, epoch, target)
        else if (step.kind === 'url') {
          const expectedUrl = new URL(step.value!).href
          if (index === startUrlIndex && new URL(target.contents.getURL()).href !== expectedUrl) {
            this.message = `Kezdőpont megnyitása: ${new URL(expectedUrl).pathname || '/'}`
            this.changed()
            await target.contents.loadURL(expectedUrl)
            await this.waitForDocument(epoch, target)
          }
          const currentUrl = target.contents.getURL()
          if (new URL(currentUrl).href !== expectedUrl) throw new Error(`Az URL nem egyezik. Aktuális cím: ${currentUrl.slice(0, 500)}`)
        } else {
          const point = await this.waitForElement(target, step, epoch)
          this.assertCurrent(epoch, target)
          target.contents.focus()
          if (step.kind === 'click') {
            if (typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error('Az elem kattintási pontja nem érhető el.')
            if (target.contents.debugger.isAttached()) {
              await target.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
              await target.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
              await target.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
            } else {
              target.contents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
              target.contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
              target.contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
            }
            // Leave one compositor frame plus event-loop time for page handlers
            // and a possible navigation to start before advancing the test.
            await this.pause(160, epoch, target)
          } else {
            if (typeof step.value !== 'string') throw new Error('A bemeneti lépés értéke hiányzik. Jelszót kézzel kell megadni a szerkesztőben.')
            await this.page(target, { kind: 'prepare-input', selector: step.selector! })
            this.assertCurrent(epoch, target)
            target.contents.selectAll()
            if (step.value) await target.contents.insertText(step.value)
            else {
              target.contents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
              target.contents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
            }
            await this.pause(80, epoch, target)
            const actual = await this.page(target, { kind: 'read-input', selector: step.selector! })
            this.assertCurrent(epoch, target)
            if (actual.value !== step.value) throw new Error('A mező nem fogadta el a megadott szöveget.')
          }
        }
        this.assertCurrent(epoch, target)
        result.status = 'passed'; this.changed()
      }
      this.mode = 'idle'; this.message = `A teszt sikeres: ${copy.length} lépés.`; this.changed()
    } catch (error) {
      if (error instanceof Cancelled || epoch !== this.epoch) return
      const message = error instanceof Error ? error.message : 'A tesztlépés sikertelen.'
      const result = this.results.find(entry => entry.status === 'running')
      if (result) { result.status = 'failed'; result.message = message }
      this.mode = 'idle'; this.message = message; this.changed()
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
    this.target = null; this.disposed = true
    this.bindDebugger(null)
  }
}
