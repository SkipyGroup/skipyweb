import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDomain } from 'tldts'
import type { SdtProject, SdtRun, SdtStep, SdtSuite, SdtTest } from './sdt-types'

const MAX_TESTS = 50
const MAX_STEPS = 100
const MAX_RUNS_PER_SITE = 20
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
    if (['click','input','select','check','assert-visible','assert-text','assert-value'].includes(String(item.kind))) {
      const step: SdtStep = { id: stepId, kind: item.kind as SdtStep['kind'], selector: text(item.selector, 2048, 'A lépéshez érvényes CSS-lokátor szükséges.') }
      if (item.x !== undefined || item.y !== undefined) {
        if (typeof item.x !== 'number' || typeof item.y !== 'number' || !Number.isFinite(item.x) || !Number.isFinite(item.y) || item.x < 0 || item.y < 0 || item.x > 100000 || item.y > 100000) throw new Error('Érvénytelen kattintási koordináták.')
        step.x = item.x
        step.y = item.y
      }
      // Password fields are recorded as empty placeholders, never as captured secrets.
      if (item.kind === 'input' && item.value !== undefined) step.value = text(item.value, 10000, 'A beírt szöveg legfeljebb 10000 karakter lehet.', true)
      if ((item.kind === 'select' || item.kind === 'check') && item.value !== undefined) step.value = text(item.value, 10000, 'Érvénytelen mezőérték.', true)
      if (item.kind === 'input' && item.sensitive === true) { step.sensitive = true; delete step.value }
      if (item.kind === 'assert-text' && item.value !== undefined) step.value = text(item.value, 10000, 'Az ellenőrzött szöveg legfeljebb 10000 karakter lehet.', true)
      if (item.timeoutMs !== undefined) { if (typeof item.timeoutMs !== 'number' || !Number.isInteger(item.timeoutMs) || item.timeoutMs < 100 || item.timeoutMs > 30000) throw new Error('Az időkorlát 100–30000 ms lehet.'); step.timeoutMs = item.timeoutMs }
      if (item.name !== undefined) step.name = text(item.name, 120, 'A lépés neve legfeljebb 120 karakter lehet.', true).trim()
      if (item.expectedValue !== undefined) step.expectedValue = text(item.expectedValue, 10000, 'Az elvárt érték legfeljebb 10000 karakter lehet.', true)
      if (['equals','contains','not-contains','regex','empty','not-empty'].includes(String(item.operator))) step.operator=item.operator as SdtStep['operator']
      if(item.regexFlags!==undefined)step.regexFlags=text(item.regexFlags,10,'Érvénytelen regex kapcsoló.',true)
      if(item.disabled===true)step.disabled=true
      return step
    }
    const metadata = { ...(item.name === undefined ? {} : { name: text(item.name, 120, 'A lépés neve legfeljebb 120 karakter lehet.', true).trim() }), ...(item.expectedValue === undefined ? {} : { expectedValue: text(item.expectedValue, 10000, 'Az elvárt érték legfeljebb 10000 karakter lehet.', true) }),...(item.disabled===true?{disabled:true}:{}) }
    if (item.kind === 'key') return { id: stepId, kind: 'key', value: text(item.value, 100, 'Adj meg egy billentyűt vagy kombinációt.'), ...metadata }
    if (item.kind === 'screenshot') return { id: stepId, kind: 'screenshot', ...(item.value === undefined ? {} : { value: text(item.value, 100, 'A képernyőkép neve túl hosszú.', true) }), ...metadata }
    if (item.kind === 'wait') {
      if (typeof item.ms !== 'number' || !Number.isInteger(item.ms) || item.ms < 0 || item.ms > 30000) throw new Error('A várakozás 0 és 30000 ms között lehet.')
      return { id: stepId, kind: 'wait', ms: item.ms, ...metadata }
    }
    if (item.kind === 'url') {
      const value = text(item.value, 8192, 'Érvénytelen ellenőrzendő webcím.')
      try {
        if(value.includes('${'))return { id: stepId, kind: 'url', value, ...metadata }
        const url = new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      } catch { throw new Error('Az URL-ellenőrzéshez HTTP(S) webcím szükséges.') }
      return { id: stepId, kind: 'url', value, ...metadata }
    }
    throw new Error('Nem támogatott tesztlépés.')
  })
}

/** A separate SDT file: browser library and privacy data are never rewritten here. */
export class SdtStore {
  private tests: SdtTest[] = []
  private runs: SdtRun[] = []
  private projects:SdtProject[]=[]
  private suites:SdtSuite[]=[]
  private writeChain: Promise<void> = Promise.resolve()
  private loadError: string | null = null

  constructor(private readonly filePath: string) {}

  private ensureSite(site:string){
    let project=this.projects.find(item=>item.site===site)
    if(!project){project={id:randomUUID(),site,name:`${site} projekt`,baseUrl:`https://${site}/`,defaultTimeoutMs:5000,traceEnabled:true,variables:{},secretVariables:[],continueOnFailure:true};this.projects.push(project)}
    let suite=this.suites.find(item=>item.projectId===project.id)
    if(!suite){suite={id:randomUUID(),projectId:project.id,name:'Alapértelmezett tesztcsomag'};this.suites.push(suite)}
    return {project,suite}
  }

  load(): void {
    this.tests = []
    this.loadError = null
    try {
      if (fs.statSync(this.filePath).size > MAX_FILE_BYTES) throw new Error('Az SDT-adatfájl túl nagy.')
      const data = record(JSON.parse(fs.readFileSync(this.filePath, 'utf8')))
      if (![1,2,3,4].includes(Number(data.version)) || !Array.isArray(data.tests) || data.tests.length > MAX_TESTS) throw new Error('Nem támogatott SDT-adatformátum.')
      const ids = new Set<string>()
      this.tests = data.tests.map(value => {
        const item = record(value)
        const testId = id(item.id)
        if (ids.has(testId)) throw new Error('Ismétlődő tesztazonosító.')
        ids.add(testId)
        if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) throw new Error('Érvénytelen mentési idő.')
        const steps = validateSteps(item.steps)
        if (!steps.length) throw new Error('A mentett teszt üres.')
        return { id: testId, site: siteKey(item.site), ...(typeof item.suiteId==='string'?{suiteId:item.suiteId}:{}), name: text(item.name, 100, 'Érvénytelen tesztnév.').trim(), steps, updatedAt: item.updatedAt }
      })
      this.runs = data.version === 2 && Array.isArray(data.runs) ? (data.runs as SdtRun[]).filter(run => run && typeof run.id === 'string' && typeof run.site === 'string' && Array.isArray(run.results)).slice(0, 1000) : []
      if((data.version===3||data.version===4)&&Array.isArray(data.projects)&&Array.isArray(data.suites)){this.projects=(data.projects as SdtProject[]).map(project=>({...project,variables:project.variables??{},secretVariables:project.secretVariables??[],continueOnFailure:project.continueOnFailure!==false}));this.suites=data.suites as SdtSuite[];this.runs=Array.isArray(data.runs)?data.runs as SdtRun[]:[]}
      for(const site of new Set(this.tests.map(test=>test.site))){const {suite}=this.ensureSite(site);for(const test of this.tests.filter(item=>item.site===site&&!item.suiteId))test.suiteId=suite.id}
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
  listProjects(site:string|null){if(site)this.ensureSite(site);return structuredClone(site?this.projects.filter(project=>project.site===site):[])}
  listSuites(site:string|null){if(site)this.ensureSite(site);const projects=new Set(this.projects.filter(project=>project.site===site).map(project=>project.id));return structuredClone(this.suites.filter(suite=>projects.has(suite.projectId)))}
  createSuite(site:string,name:string):Promise<SdtSuite>{return this.write(()=>{const project=this.projects.find(item=>item.site===site);if(!project)throw new Error('A projekt nem található.');const suite={id:randomUUID(),projectId:project.id,name:text(name,80,'A tesztcsomag neve 1–80 karakter lehet.').trim()};this.suites.push(suite);return structuredClone(suite)})}
  updateProject(site:string,input:unknown):Promise<SdtProject>{return this.write(()=>{const item=record(input),{project}=this.ensureSite(site);const baseUrl=text(item.baseUrl,8192,'Adj meg érvényes base URL-t.');const parsed=new URL(baseUrl);if(!['http:','https:'].includes(parsed.protocol))throw new Error('A base URL HTTP(S) cím legyen.');const variables:Record<string,string>={};for(const [key,value] of Object.entries(record(item.variables??{}))){if(!/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(key)||key==='baseUrl'||typeof value!=='string'||value.length>10000)throw new Error('Érvénytelen projektváltozó.');variables[key]=value}const secretVariables=Array.isArray(item.secretVariables)?item.secretVariables.filter((v):v is string=>typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,49}$/.test(v)).slice(0,50):[];Object.assign(project,{baseUrl:parsed.href,variables,secretVariables,continueOnFailure:item.continueOnFailure!==false});return structuredClone(project)})}
  listRuns(site: string | null): SdtRun[] { return site ? structuredClone(this.runs.filter(run => run.site === site).sort((a,b) => b.startedAt-a.startedAt).slice(0,MAX_RUNS_PER_SITE)) : [] }
  artifactPaths():Set<string>{return new Set(this.runs.flatMap(run=>run.results.flatMap(result=>[result.screenshot,result.domSnapshot]).filter((value):value is string=>!!value)))}
  addRun(run: SdtRun): Promise<void> { return this.write(() => { this.runs.unshift(structuredClone(run)); const keep=new Set<string>();this.runs=this.runs.filter(item=>{const count=[...keep].filter(key=>key.startsWith(item.site+'|')).length;if(count>=MAX_RUNS_PER_SITE)return false;keep.add(`${item.site}|${item.id}`);return true}) }) }
  clearRuns(site:string):Promise<void>{return this.write(()=>{this.runs=this.runs.filter(run=>run.site!==site)})}

  save(site: string, input: unknown): Promise<SdtTest> {
    // Validate and copy before queueing so the caller cannot mutate a queued write.
    let next: SdtTest
    try {
      const item = record(input)
      const steps = validateSteps(item.steps)
      if (!steps.length) throw new Error('Adj hozzá legalább egy tesztlépést.')
      const suiteId=typeof item.suiteId==='string'&&this.suites.some(suite=>suite.id===item.suiteId)?item.suiteId:this.suites.find(suite=>this.projects.find(project=>project.id===suite.projectId)?.site===site)?.id
      next = { id: item.id === undefined ? randomUUID() : id(item.id), site: siteKey(site), ...(suiteId?{suiteId}:{}), name: text(item.name, 100, 'A tesztnév 1–100 karakter lehet.').trim(), steps, updatedAt: Date.now() }
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
      const previous = this.tests, previousRuns = this.runs, previousProjects=this.projects, previousSuites=this.suites
      let temporary: string | undefined
      try {
        const result = change()
        const snapshot = JSON.stringify({ version: 4, projects:this.projects, suites:this.suites, tests: this.tests, runs: this.runs }, null, 2)
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
        temporary = `${this.filePath}.${randomUUID()}.tmp`
        await fs.promises.writeFile(temporary, snapshot, { encoding: 'utf8', flag: 'wx' })
        await fs.promises.rename(temporary, this.filePath)
        return result
      } catch (error) {
        this.tests = previous; this.runs = previousRuns; this.projects=previousProjects; this.suites=previousSuites
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
