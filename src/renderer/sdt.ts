import './sdt.css'
import { createIcons, CodeXml, X, Pipette, Braces, ListChecks, Send, Trash2, Circle, Play, Save, ArrowUp, ArrowDown, Copy } from 'lucide'
import type { SdtState, SdtReply, SdtStep, SdtApiRequest } from '../main/sdt-types'

type Bridge = { command(action: string, payload?: unknown): Promise<SdtReply>; onState(callback: (state: SdtState) => void): () => void }
const bridge = (window as unknown as { sdt: Bridge }).sdt
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const icons = { CodeXml, X, Pipette, Braces, ListChecks, Send, Trash2, Circle, Play, Save, ArrowUp, ArrowDown, Copy }
const renderIcons = () => createIcons({ icons })
let state: SdtState | undefined
let section = 'colors'
let draft: SdtStep[] = []
let editedDraft = false
let testId = ''
let lastSite: string | null | undefined
let selectionSignature = ''
let testsSignature = ''
let responseSignature = ''
let runsSignature = ''
let hierarchySignature = ''
let localMessage = ''
const validationErrors=new Map<string,string>()
const stepElements = new Map<string, HTMLLIElement>()

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
function icon(name: string) { const node = make('i'); node.dataset.lucide = name; return node }
function button(text: string, callback: () => void, className = '') {
  const node = make('button', className, text)
  node.type = 'button'; node.onclick = callback; return node
}
function setMessage(text: string, error = false) {
  $('message').textContent = text
  $('message').hidden = !text
  $('message').classList.toggle('error', error)
}
function requestSecret(step:SdtStep):Promise<string|null>{
  const dialog=$<HTMLDialogElement>('secret-dialog'),input=$<HTMLInputElement>('secret-value')
  $('secret-description').textContent=`Adj meg egy ideiglenes értéket ehhez: ${step.selector||step.id}. Az érték nem kerül mentésre.`
  input.value='';dialog.showModal();queueMicrotask(()=>input.focus())
  return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'?input.value:null),{once:true})})
}
async function command(action: string, payload?: unknown): Promise<boolean> {
  try {
    localMessage = ''
    const reply = await bridge.command(action, payload)
    if (!reply.ok) { localMessage = reply.error || 'A művelet nem sikerült.'; setMessage(localMessage, true); return false }
    return true
  } catch {
    localMessage = 'Az SDT művelete nem érhető el.'
    setMessage(localMessage, true); return false
  }
}
function openSection(name: string) {
  section = name
  for (const node of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-section]'))) {
    const selected = node.dataset.section === name
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1
    $(`section-${node.dataset.section}`).hidden = !selected
  }
}
function copy(value: string, node: HTMLButtonElement) {
  const label = node.textContent
  void command('copy', value).then(ok => {
    if (!ok) return
    node.textContent = 'Másolva'
    setTimeout(() => { if (node.isConnected) node.textContent = label }, 1200)
  })
}
function renderSelection() {
  const selection = state?.selection
  const signature = JSON.stringify(selection)
  if (signature === selectionSignature) return
  selectionSignature = signature
  $('selection').hidden = !selection; $('color-empty').hidden = !!selection
  $('color-list').replaceChildren()
  if (!selection) return
  $('selector').textContent = selection.selector;$('selector').title='Kattints a lokátor másolásához';$('selector').onclick=()=>copy(selection.selector,$('selector') as unknown as HTMLButtonElement)
  if(selection.typography){const card=make('div','color-card');card.append(make('strong','','Tipográfia'),make('small','',`${selection.typography.fontFamily} · ${selection.typography.fontSize} · ${selection.typography.fontWeight} · ${selection.typography.lineHeight}`));$('color-list').append(card)}
  for (const color of selection.colors) {
    const card = make('div', 'color-card'), heading = make('div', 'color-heading')
    const swatch = make('div', 'color-swatch'), fill = make('span')
    if (CSS.supports('color', color.css)) fill.style.backgroundColor = color.css
    swatch.append(fill)
    const info = make('div'); info.append(make('strong', '', color.label), make('small', '', color.css))
    heading.append(swatch, info); card.append(heading)
    for (const [label, value] of [['HEX', color.hex], ['RGB', color.rgb]] as const) {
      const row = make('div', 'color-value'); row.append(make('span', '', label), make('code', '', value ?? 'Nem alakítható át'))
      if (value) { const copyButton = button('Másolás', () => copy(value, copyButton)); row.append(copyButton) }
      card.append(row)
    }
    $('color-list').append(card)
  }
}
function addHeader(name = '', value = '') {
  if ($('headers').children.length >= 50) return
  const row = make('div', 'header-row'), key = make('input'), content = make('input')
  key.value = name; key.placeholder = 'Fejléc neve'; key.setAttribute('aria-label', 'Fejléc neve'); key.maxLength = 200; key.spellcheck = false
  content.value = value; content.placeholder = 'Érték'; content.setAttribute('aria-label', 'Fejléc értéke'); content.maxLength = 8192; content.spellcheck = false
  const remove = button('', () => row.remove(), 'icon-button'); remove.title = 'Fejléc eltávolítása'; remove.setAttribute('aria-label', remove.title); remove.append(icon('x'))
  row.append(key, content, remove); $('headers').append(row); renderIcons()
}
function renderResponse() {
  const result = state?.apiResult
  const signature = JSON.stringify(result)
  if (signature === responseSignature) return
  responseSignature = signature
  $('api-response').hidden = !result
  if (!result) return
  $('response-status').textContent = result.status ? `${result.status} ${result.statusText}` : 'A kérés nem sikerült'
  $('response-status').classList.toggle('error', !!result.error || result.status >= 400)
  $('response-time').textContent = `${Math.round(result.elapsedMs)} ms`
  $('response-size').textContent = `${(result.bytes / 1024).toFixed(1)} KB`
  $('response-error').hidden = !result.error; $('response-error').textContent = result.error ?? ''
  $('response-headers').textContent = result.headers.map(header => `${header.name}: ${header.value}`).join('\n') || 'Nincs válaszfejléc.'
  let body = result.body
  try { body = JSON.stringify(JSON.parse(body), null, 2) } catch { /* Text responses are shown unchanged. */ }
  $('response-body').textContent = body || '(üres válasz)'
  $<HTMLButtonElement>('response-copy').disabled = !result.body
}
function renderSavedTests() {
  const tests = state?.tests ?? []
  const signature = JSON.stringify(tests.map(test => [test.id, test.name, test.updatedAt, test.steps.filter(step => step.kind === 'url').map(step => step.value)]))
  if (signature === testsSignature) return
  testsSignature = signature
  const select = $<HTMLSelectElement>('saved-tests')
  const placeholder = make('option', '', 'Új teszt'); placeholder.value = ''
  select.replaceChildren(placeholder)
  for (const test of tests) {
    const routes = new Set(test.steps.filter(step => step.kind === 'url' && step.value).map(step => {
      try { const url = new URL(step.value!); return `${url.pathname}${url.search}${url.hash}` }
      catch { return step.value! }
    }))
    const option = make('option', '', routes.size > 1 ? `${test.name} · ${routes.size} útvonal` : test.name)
    option.value = test.id; select.append(option)
  }
  if (!tests.some(test => test.id === testId)) testId = ''
  select.value = testId
  $<HTMLButtonElement>('test-delete').disabled = !testId || state?.mode !== 'idle'
}
async function syncDraft() {
  if (!editedDraft) return true
  const snapshot = JSON.stringify(draft)
  const ok = await command('draft-set', draft)
  if (ok && snapshot === JSON.stringify(draft)) editedDraft = false
  return ok
}
function renderHierarchy(){
  const projects=state?.projects??[],suites=state?.suites??[]
  const signature=JSON.stringify([projects,suites,testId])
  if(signature===hierarchySignature)return
  hierarchySignature=signature
  const project=$<HTMLSelectElement>('project-select'),suite=$<HTMLSelectElement>('suite-select')
  const selectedTest=state?.tests.find(item=>item.id===testId)
  project.replaceChildren(...projects.map(item=>{const option=make('option','',item.name);option.value=item.id;return option}))
  if(projects[0])project.value=projects[0].id
  suite.replaceChildren(...suites.map(item=>{const option=make('option','',item.name);option.value=item.id;return option}))
  suite.value=selectedTest?.suiteId&&suites.some(item=>item.id===selectedTest.suiteId)?selectedTest.suiteId:(suites[0]?.id??'')
}
function updateDraft(id: string, patch: Partial<SdtStep>) {
  draft = draft.map(step => step.id === id ? { ...step, ...patch } : step)
  editedDraft = true
}
function alterSteps(next: SdtStep[]) {
  draft = next; editedDraft = true; renderSteps(); void syncDraft()
}
function addStep(kind: SdtStep['kind']) {
  if (draft.length >= 100 || state?.mode !== 'idle') return
  const step: SdtStep = { id: crypto.randomUUID(), kind }
  if (kind === 'wait') step.ms = 500
  if (kind === 'url') step.value = state.url
  if (['click','input','assert-visible','assert-text'].includes(kind)) step.selector = ''
  if (kind === 'input') step.value = ''
  if (kind === 'key') step.value = 'Enter'
  if (kind === 'assert-text') step.value = ''
  alterSteps([...draft, step])
  stepElements.get(step.id)?.scrollIntoView({ block: 'nearest' })
}
function moveStep(id: string, offset: number) {
  const index = draft.findIndex(step => step.id === id), target = index + offset
  if (target < 0 || target >= draft.length) return
  const next = [...draft]; [next[index], next[target]] = [next[target], next[index]]; alterSteps(next)
}
function inputField(label: string, key: 'name' | 'selector' | 'value' | 'expectedValue' | 'ms' | 'timeoutMs', step: SdtStep) {
  const wrapper = make('label', '', label)
  const input = make('input'); input.dataset.field = key
  input.type = key === 'ms' || key === 'timeoutMs' ? 'number' : 'text'; input.spellcheck = false
  if (key === 'ms' || key === 'timeoutMs') { input.min = key === 'timeoutMs'?'100':'0'; input.max = '30000'; input.step = '100' }
  else { input.maxLength = key === 'name' ? 120 : key === 'selector' ? 2000 : 10000; input.placeholder = key === 'name' ? 'Például: Bejelentkezés gomb' : key === 'expectedValue' ? 'A mező várt értéke a lépés után' : key === 'selector' ? '#element vagy [data-testid="..."]' : step.kind === 'url' ? 'https://pelda.hu/' : step.value === undefined ? 'Kézzel add meg' : 'Beírandó szöveg' }
  input.oninput = () => updateDraft(step.id, key === 'ms' ? { ms: Number(input.value) } : { [key]: input.value })
  input.onchange = () => void syncDraft()
  wrapper.append(input); return wrapper
}
function createStepElement(step: SdtStep) {
  const row = make('li', 'step'), heading = make('div', 'step-heading')
  row.dataset.kind = step.kind
  const number = make('span', 'step-index'), kind = make('select')
  kind.setAttribute('aria-label', 'Lépés típusa')
  for (const [value, label] of [['click', 'Kattintás'], ['input', 'Szövegbevitel'], ['key','Billentyű'], ['wait', 'Várakozás'], ['url', 'URL-ellenőrzés'],['assert-visible','Láthatóság'],['assert-text','Szöveg ellenőrzése'],['screenshot','Képernyőkép']]) {
    const option = make('option', '', label); option.value = value; kind.append(option)
  }
  kind.value = step.kind
  kind.onchange = () => {
    const replacement: SdtStep = { id: step.id, ...(step.name?{name:step.name}:{}), kind: kind.value as SdtStep['kind'] }
    if (replacement.kind === 'wait') replacement.ms = 500
    if (replacement.kind === 'url') replacement.value = state?.url ?? ''
    if (['click','input','assert-visible','assert-text'].includes(replacement.kind)) replacement.selector = ''
    if (replacement.kind === 'input') replacement.value = ''
    if(replacement.kind==='key')replacement.value='Enter'
    if(replacement.kind==='assert-text')replacement.value=''
    alterSteps(draft.map(entry => entry.id === step.id ? replacement : entry))
  }
  heading.append(number, kind)
  for (const [name, label, callback] of [
    ['arrow-up', 'Lépés feljebb', () => moveStep(step.id, -1)],
    ['arrow-down', 'Lépés lejjebb', () => moveStep(step.id, 1)],
    ['copy', 'Lépés másolása', () => {const index=draft.findIndex(entry=>entry.id===step.id);const clone={...step,id:crypto.randomUUID()};const next=[...draft];next.splice(index+1,0,clone);alterSteps(next)}],
    ['trash-2', 'Lépés törlése', () => alterSteps(draft.filter(entry => entry.id !== step.id))],
  ] as const) {
    const control = button('', callback, 'icon-button'); control.title = label; control.setAttribute('aria-label', label); control.dataset.action = name; control.append(icon(name)); heading.append(control)
  }
  row.append(heading)
  row.append(inputField('Lépés neve', 'name', step))
  if (['click','input','assert-visible','assert-text'].includes(step.kind)) row.append(inputField('CSS-lokátor', 'selector', step))
  if (step.kind === 'input') row.append(inputField('Szöveg', 'value', step))
  if (step.kind === 'key') row.append(inputField('Billentyű vagy kombináció', 'value', step))
  if (step.kind === 'assert-text') row.append(inputField('Elvárt szövegrészlet', 'value', step))
  if (step.kind === 'screenshot') row.append(inputField('Képernyőkép neve', 'value', step))
  if (step.kind === 'wait') row.append(inputField('Várakozás (ms)', 'ms', step))
  if (step.kind === 'url') row.append(inputField('Elvárt URL', 'value', step))
  if (['click','input','assert-visible','assert-text'].includes(step.kind)) row.append(inputField('Időkorlát (ms)', 'timeoutMs', step))
  if (['click','input','assert-visible','assert-text'].includes(step.kind)) row.append(inputField('Elvárt érték (opcionális)', 'expectedValue', step))
  const result = make('div', 'step-result'); result.setAttribute('role', 'status'); row.append(result)
  return row
}
function renderRuns(){const runs=state?.runs??[],signature=JSON.stringify(runs);if(signature===runsSignature)return;runsSignature=signature;const root=$('runs');root.replaceChildren();if(!runs.length){root.append(make('p','hint','Még nincs futási előzmény.'));return}for(const run of runs){const card=make('article',`run-card ${run.status}`);const head=make('div','run-head');head.append(make('strong','',run.name),make('span','',new Date(run.startedAt).toLocaleString('hu-HU')));const summary=make('p','',`${run.passed} sikeres · ${run.failed} hibás · ${(run.durationMs/1000).toFixed(1)} mp`);const details=document.createElement('details');const ds=document.createElement('summary');ds.textContent='Lépések részletei';details.append(ds);for(const result of run.results){const line=make('div',`run-step ${result.status}`,`${result.status==='passed'?'✓':'✕'} ${result.name||result.id} · ${result.durationMs||0} ms${result.message?' · '+result.message:''}`);details.append(line)}const actions=make('div','run-actions');actions.append(button('HTML',()=>void command('run-export',{id:run.id,format:'html'})),button('JSON',()=>void command('run-export',{id:run.id,format:'json'})));card.append(head,summary,details,actions);root.append(card)}}
function renderSteps() {
  const existing = new Set(draft.map(step => step.id)), results = new Map(state?.results.map(result => [result.id, result]) ?? [])
  const busy = state?.mode !== 'idle'
  for (const [id, row] of stepElements) if (!existing.has(id)) { row.remove(); stepElements.delete(id) }
  for (const [index, step] of draft.entries()) {
    let row = stepElements.get(step.id)
    if (row && row.dataset.kind !== step.kind) { row.remove(); row = undefined }
    if (!row) { row = createStepElement(step); stepElements.set(step.id, row) }
    if ($('steps').children[index] !== row) $('steps').insertBefore(row, $('steps').children[index] ?? null)
    row.querySelector('.step-index')!.textContent = String(index + 1)
    for (const input of Array.from(row.querySelectorAll<HTMLInputElement>('[data-field]'))) {
      const key = input.dataset.field as 'name' | 'selector' | 'value' | 'expectedValue' | 'ms' | 'timeoutMs', value = String(step[key] ?? (key==='timeoutMs'?5000:''))
      if (document.activeElement !== input && input.value !== value) input.value = value
    }
    for (const input of Array.from(row.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))) input.disabled = busy
    row.querySelector<HTMLButtonElement>('[data-action="arrow-up"]')!.disabled = busy || index === 0
    row.querySelector<HTMLButtonElement>('[data-action="arrow-down"]')!.disabled = busy || index === draft.length - 1
    const result = results.get(step.id),validation=validationErrors.get(step.id)
    row.dataset.status = result?.status ?? ''
    row.querySelector('.step-result')!.textContent = validation|| (result ? `${({ running: 'Folyamatban…', passed: 'Sikeres', failed: 'Hiba', cancelled: 'Megszakítva' })[result.status]}${result.message ? ` · ${result.message}` : ''}` : '')
    row.classList.toggle('validation-error',!!validation)
  }
  $('step-count').textContent = `${draft.length} / 100`
  $('steps-empty').hidden = !!draft.length
  $<HTMLSelectElement>('step-add').disabled = busy || draft.length >= 100
  renderIcons()
}
function render(next: SdtState) {
  state = next
  if (lastSite !== next.site) {
    lastSite = next.site; testId = ''; editedDraft = false; testsSignature = ''; $<HTMLInputElement>('test-name').value = ''
  }
  if (!editedDraft) draft = next.draft.map(step => ({ ...step }))
  const compact = next.mode === 'picking' || next.mode === 'recording'
  document.body.classList.toggle('compact', compact); $('compact').hidden = !compact
  $('compact-title').textContent = next.mode === 'picking' ? 'Elem kiválasztása' : `UI-teszt rögzítése · ${next.draft.length} lépés`
  $('compact-description').textContent = next.mode === 'picking' ? 'Kattints egy elemre · Esc: kilépés' : 'Azonos webhelyen az új útvonalakat is rögzíti · Esc: leállítás'
  $('site-label').textContent = next.site ?? 'Nyiss meg egy weboldalt'
  if (!localMessage) setMessage(next.message)
  const hasSite = !!next.site, busy = next.mode !== 'idle'
  $('colors-no-site').hidden = hasSite; $('tests-no-site').hidden = hasSite
  $<HTMLButtonElement>('pick').disabled = !hasSite || busy
  $<HTMLButtonElement>('record').disabled = !hasSite || busy || draft.length >= 100
  $<HTMLButtonElement>('run').disabled = !hasSite || busy || !draft.length
  $('run').hidden = next.mode === 'running'; $('run-stop').hidden = next.mode !== 'running'
  const completed=next.results.filter(result=>result.status!=='running').length;$('run-progress').hidden=next.mode!=='running';$('run-progress').textContent=next.mode==='running'?`Futás: ${completed+1} / ${draft.length} lépés · ${next.results.find(result=>result.status==='running')?.id||'indítás'}`:''
  $<HTMLButtonElement>('test-save').disabled = !hasSite || busy || !draft.length
  $<HTMLButtonElement>('test-new').disabled = busy
  $<HTMLButtonElement>('test-delete').disabled = busy || !testId
  $<HTMLSelectElement>('saved-tests').disabled = busy
  $<HTMLInputElement>('test-name').disabled = busy
  $<HTMLButtonElement>('api-send').disabled = next.apiRunning
  $('api-cancel').hidden = !next.apiRunning
  $('api-send').title = next.apiRunning ? 'Kérés folyamatban…' : 'Kérés küldése'
  renderSelection(); renderResponse(); renderSavedTests(); renderHierarchy(); renderSteps();renderRuns()
}

document.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(tab => {
  tab.onclick = () => openSection(tab.dataset.section!)
  tab.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const names = ['colors', 'api', 'tests'], index = names.indexOf(section)
    openSection(names[(index + (event.key === 'ArrowRight' ? 1 : 2)) % names.length]); $(`tab-${section}`).focus()
  }
})
$('close').onclick = () => void command('close')
$('pick').onclick = () => { openSection('colors'); void command('pick-start') }
$('compact-stop').onclick = () => void command('stop')
$('run-stop').onclick = () => void command('stop')
$('header-add').onclick = () => addHeader()
$('api-cancel').onclick = () => void command('api-cancel')
$('response-copy').onclick = () => { if (state?.apiResult?.body) copy(state.apiResult.body, $<HTMLButtonElement>('response-copy')) }
$<HTMLSelectElement>('api-method').onchange = () => {
  const noBody = ['GET', 'HEAD'].includes($<HTMLSelectElement>('api-method').value)
  $<HTMLTextAreaElement>('api-body').disabled = noBody; $('body-hint').hidden = !noBody
}
$<HTMLFormElement>('api-form').onsubmit = event => {
  event.preventDefault()
  if (state?.apiRunning) return
  const headers = Array.from($('headers').children).map(row => { const inputs = row.querySelectorAll('input'); return { name: inputs[0].value.trim(), value: inputs[1].value } }).filter(header => header.name || header.value)
  const payload: SdtApiRequest = { url: $<HTMLInputElement>('api-url').value.trim(), method: $<HTMLSelectElement>('api-method').value as SdtApiRequest['method'], headers, body: $<HTMLTextAreaElement>('api-body').value, bodyType: $<HTMLSelectElement>('body-type').value as 'json' | 'text' }
  void command('api-send', payload)
}
const saveApiDraft=()=>{try{localStorage.setItem('skipy-sdt-api-draft',JSON.stringify({url:$<HTMLInputElement>('api-url').value,method:$<HTMLSelectElement>('api-method').value,body:$<HTMLTextAreaElement>('api-body').value,bodyType:$<HTMLSelectElement>('body-type').value,headers:Array.from($('headers').children).map(row=>{const fields=row.querySelectorAll('input');return{name:fields[0].value,value:fields[1].value}})}))}catch{/* Draft persistence is optional. */}}
$('api-form').addEventListener('input',saveApiDraft);$('api-form').addEventListener('change',saveApiDraft)
$<HTMLTextAreaElement>('api-body').addEventListener('blur',()=>{if($<HTMLSelectElement>('body-type').value!=='json')return;const body=$<HTMLTextAreaElement>('api-body');if(!body.value.trim())return;try{body.value=JSON.stringify(JSON.parse(body.value),null,2);saveApiDraft()}catch{/* Validation displays the useful error when sent. */}})
$<HTMLSelectElement>('step-add').onchange = () => { const select = $<HTMLSelectElement>('step-add'); if (select.value) addStep(select.value as SdtStep['kind']); select.value = '' }
$('record').onclick = async () => { if (await syncDraft()) void command('record-start') }
$('run').onclick = async () => {validationErrors.clear();const run=$<HTMLButtonElement>('run'),label=run.querySelector('span')!;label.textContent='Ellenőrzés…';run.disabled=true;try{if(!draft.length){setMessage('A teszt nem tartalmaz lépéseket.',true);return}for(const step of draft){if(['click','input','assert-visible','assert-text'].includes(step.kind)&&!step.selector?.trim())validationErrors.set(step.id,'Adj meg CSS-lokátort.');if(step.kind==='url'){try{const url=new URL(step.value||'');if(!['http:','https:'].includes(url.protocol))throw 0}catch{validationErrors.set(step.id,'Adj meg teljes HTTP(S) kezdőcímet.')}}if(step.timeoutMs!==undefined&&(step.timeoutMs<100||step.timeoutMs>30000))validationErrors.set(step.id,'Az időkorlát 100–30000 ms lehet.')}if(validationErrors.size){setMessage(`${validationErrors.size} lépést javítani kell az indítás előtt.`,true);renderSteps();stepElements.get(validationErrors.keys().next().value!)?.scrollIntoView({behavior:'smooth',block:'center'});return}if (!(await syncDraft()))return;const secrets:Record<string,string>={};for(const step of draft.filter(step=>step.kind==='input'&&step.sensitive)){label.textContent='Érték szükséges';const value=await requestSecret(step);if(value===null){setMessage('A futtatás megszakítva.');return}secrets[step.id]=value}label.textContent='Indítás…';const ok=await command('start',{steps:draft,secrets,name:$<HTMLInputElement>('test-name').value.trim()||'UI teszt'});label.textContent=ok?'Futás elindítva':'Futtatás'}catch(error){setMessage(error instanceof Error?error.message:'A teszt nem indítható.',true)}finally{if(state?.mode!=='running')run.disabled=false;setTimeout(()=>{if(label.isConnected)label.textContent='Futtatás'},900)}}
$('runs-clear').onclick=()=>void command('runs-clear')
$('suite-add').onclick=async()=>{const name=prompt('Az új tesztcsomag neve:')?.trim();if(!name)return;if(await command('suite-create',{name})){hierarchySignature='';setMessage('A tesztcsomag elkészült.')}}
$('test-new').onclick = () => { testId = ''; $<HTMLSelectElement>('saved-tests').value = ''; $<HTMLInputElement>('test-name').value = ''; alterSteps([]) }
$<HTMLSelectElement>('saved-tests').onchange = async () => {
  const select = $<HTMLSelectElement>('saved-tests'), test = state?.tests.find(entry => entry.id === select.value)
  if (!test) { testId = ''; $<HTMLInputElement>('test-name').value = ''; alterSteps([]); return }
  editedDraft = false; testId = test.id; $<HTMLInputElement>('test-name').value = test.name
  if (!(await command('test-load', { id: test.id }))) { testId = ''; select.value = '' }
}
$('test-save').onclick = async () => {
  const name = $<HTMLInputElement>('test-name').value.trim()
  if (!name) { setMessage('Adj nevet a tesztnek.', true); $<HTMLInputElement>('test-name').focus(); return }
  if (!(await syncDraft())) return
  const existingId = testId
  if (await command('test-save', { ...(testId ? { id: testId } : {}), suiteId:$<HTMLSelectElement>('suite-select').value, name, steps: draft })) {
    if (!existingId) {
      const saved = state?.tests.find(test => test.name === name && JSON.stringify(test.steps) === JSON.stringify(draft))
      if (saved) testId = saved.id
    }
    testsSignature = ''; renderSavedTests()
  }
}
$('test-delete').onclick = async () => {
  if (!testId) return
  if (await command('test-delete', { id: testId })) { testId = ''; $<HTMLInputElement>('test-name').value = ''; alterSteps([]) }
}
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); void command(state?.mode !== 'idle' ? 'stop' : 'close') }
})
try{const saved=JSON.parse(localStorage.getItem('skipy-sdt-api-draft')||'null');if(saved){$<HTMLInputElement>('api-url').value=String(saved.url||'');$<HTMLSelectElement>('api-method').value=String(saved.method||'GET');$<HTMLTextAreaElement>('api-body').value=String(saved.body||'');$<HTMLSelectElement>('body-type').value=String(saved.bodyType||'json');if(Array.isArray(saved.headers)&&saved.headers.length)for(const header of saved.headers.slice(0,50))addHeader(String(header.name||''),String(header.value||''));else addHeader()}else addHeader()}catch{addHeader()}$<HTMLTextAreaElement>('api-body').disabled=['GET','HEAD'].includes($<HTMLSelectElement>('api-method').value)
bridge.onState(render); void command('state'); renderIcons()
