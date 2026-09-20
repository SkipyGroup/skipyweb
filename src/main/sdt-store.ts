import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDomain } from 'tldts'
import type { SdtStep, SdtTest } from './sdt-types'

const MAX_TESTS = 50
const MAX_STEPS = 100
const MAX_FILE_BYTES = 64 * 1024 * 1024

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Érvénytelen tesztadat.')
  return input as Record<string, unknown>
}
function text(value: unknown, limit: number, message: string, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim()) || value.includes('\u0000')) throw new Error(message)
  return value
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error('Érvénytelen teszt- vagy lépésazonosító.')
  return value
}
function siteKey(value: unknown): string {
  const site = text(value, 253, 'Érvénytelen webhely.')
  try {
    const url = new URL(`https://${site}/`)
    const normalized = getDomain(url.hostname, { allowPrivateDomains: true }) || url.hostname
    if (url.hostname !== site || normalized !== site || url.port || url.username || url.password || url.pathname !== '/') throw new Error()
  } catch { throw new Error('Érvénytelen webhely.') }
  return site
}

export function validateSteps(input: unknown): SdtStep[] {
  if (!Array.isArray(input) || input.length > MAX_STEPS) throw new Error('Egy teszt legfeljebb 100 lépést tartalmazhat.')
  const ids = new Set<string>()
  return input.map(value => {
    const item = record(value)
    const stepId = item.id === undefined ? randomUUID() : id(item.id)
    if (ids.has(stepId)) throw new Error('A lépések azonosítói nem ismétlődhetnek.')
    ids.add(stepId)
    if (item.kind === 'click' || item.kind === 'input') {
      const step: SdtStep = { id: stepId, kind: item.kind, selector: text(item.selector, 2048, 'A lépéshez érvényes CSS-lokátor szükséges.') }
      if (item.x !== undefined || item.y !== undefined) {
        if (typeof item.x !== 'number' || typeof item.y !== 'number' || !Number.isFinite(item.x) || !Number.isFinite(item.y) || item.x < 0 || item.y < 0 || item.x > 100000 || item.y > 100000) throw new Error('Érvénytelen kattintási koordináták.')
        step.x = item.x
        step.y = item.y
      }
      // Password fields are recorded as empty placeholders, never as captured secrets.
      if (item.kind === 'input' && item.value !== undefined) step.value = text(item.value, 10000, 'A beírt szöveg legfeljebb 10000 karakter lehet.', true)
      return step
    }
    if (item.kind === 'wait') {
      if (typeof item.ms !== 'number' || !Number.isInteger(item.ms) || item.ms < 0 || item.ms > 30000) throw new Error('A várakozás 0 és 30000 ms között lehet.')
      return { id: stepId, kind: 'wait', ms: item.ms }
    }
    if (item.kind === 'url') {
      const value = text(item.value, 8192, 'Érvénytelen ellenőrzendő webcím.')
      try {
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      } catch { throw new Error('Az URL-ellenőrzéshez HTTP(S) webcím szükséges.') }
      return { id: stepId, kind: 'url', value }
    }
    throw new Error('Nem támogatott tesztlépés.')
  })
}

/** A separate SDT file: browser library and privacy data are never rewritten here. */
export class SdtStore {
  private tests: SdtTest[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private loadError: string | null = null

  constructor(private readonly filePath: string) {}

  load(): void {
    this.tests = []
    this.loadError = null
    try {
      if (fs.statSync(this.filePath).size > MAX_FILE_BYTES) throw new Error('Az SDT-adatfájl túl nagy.')
      const data = record(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
      if (data.version !== 1 || !Array.isArray(data.tests) || data.tests.length > MAX_TESTS) throw new Error('Nem támogatott SDT-adatformátum.')
      const ids = new Set<string>()
      this.tests = data.tests.map(value => {
        const item = record(value)
        const testId = id(item.id)
        if (ids.has(testId)) throw new Error('Ismétlődő tesztazonosító.')
        ids.add(testId)
        if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) throw new Error('Érvénytelen mentési idő.')
        const steps = validateSteps(item.steps)
        if (!steps.length) throw new Error('A mentett teszt üres.')
        return { id: testId, site: siteKey(item.site), name: text(item.name, 100, 'Érvénytelen tesztnév.').trim(), steps, updatedAt: item.updatedAt }
      })
    } catch (error) {
      this.tests = []
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = 'A mentett SDT-adatok nem olvashatók. A meglévő adatfájl megőrzése érdekében a mentés letiltva.'
    }
  }

  list(site: string | null): SdtTest[] {
    if (site === null) return []
    const selected = this.tests.filter(test => test.site === site).sort((a, b) => b.updatedAt - a.updatedAt)
    return structuredClone(selected)
  }

  save(site: string, input: unknown): Promise<SdtTest> {
    // Validate and copy before queueing so the caller cannot mutate a queued write.
    let next: SdtTest
    try {
      const item = record(input)
      const steps = validateSteps(item.steps)
      if (!steps.length) throw new Error('Adj hozzá legalább egy tesztlépést.')
      next = { id: item.id === undefined ? randomUUID() : id(item.id), site: siteKey(site), name: text(item.name, 100, 'A tesztnév 1–100 karakter lehet.').trim(), steps, updatedAt: Date.now() }
    } catch (error) { return Promise.reject(error) }
    return this.write(() => {
      const existing = this.tests.find(test => test.id === next.id)
      if (existing && existing.site !== next.site) throw new Error('Másik webhely tesztje nem módosítható.')
      if (!existing && this.tests.length >= MAX_TESTS) throw new Error('Legfeljebb 50 teszt menthető. Előbb törölj egy korábbi tesztet.')
      this.tests = [...this.tests.filter(test => test.id !== next.id), next]
      return structuredClone(next)
    })
  }

  remove(site: string, testId: string): Promise<void> {
    try { siteKey(site); id(testId) } catch (error) { return Promise.reject(error) }
    return this.write(() => { this.tests = this.tests.filter(test => test.site !== site || test.id !== testId) })
  }

  flush(): Promise<void> { return this.writeChain }

  private write<T>(change: () => T): Promise<T> {
    const operation = this.writeChain.catch(() => undefined).then(async () => {
      if (this.loadError) throw new Error(this.loadError)
      const previous = this.tests
      let temporary: string | undefined
      try {
        const result = change()
        const snapshot = JSON.stringify({ version: 1, tests: this.tests }, null, 2)
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
        temporary = `${this.filePath}.${randomUUID()}.tmp`
        await fs.promises.writeFile(temporary, snapshot, { encoding: 'utf8', flag: 'wx' })
        await fs.promises.rename(temporary, this.filePath)
        return result
      } catch (error) {
        this.tests = previous
        if (temporary) await fs.promises.unlink(temporary).catch(() => undefined)
        throw error
      }
    })
    this.writeChain = operation.then(() => undefined)
    // The returned operation carries the error; keep flush rejection observable without an unhandled promise.
    void this.writeChain.catch(() => undefined)
    return operation
  }
}
