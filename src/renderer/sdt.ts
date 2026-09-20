import './sdt.css'
import { createIcons, CodeXml, X, Pipette, Braces, ListChecks, Send, Trash2, Circle, Play, Save, ArrowUp, ArrowDown } from 'lucide'
import type { SdtState, SdtReply, SdtStep, SdtApiRequest } from '../main/sdt-types'

type Bridge = { command(action: string, payload?: unknown): Promise<SdtReply>; onState(callback: (state: SdtState) => void): () => void }
const bridge = (window as unknown as { sdt: Bridge }).sdt
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const icons = { CodeXml, X, Pipette, Braces, ListChecks, Send, Trash2, Circle, Play, Save, ArrowUp, ArrowDown }
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
let localMessage = ''
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
  $('selector').textContent = selection.selector
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
  if (kind === 'click' || kind === 'input') step.selector = ''
  if (kind === 'input') step.value = ''
  alterSteps([...draft, step])
  stepElements.get(step.id)?.scrollIntoView({ block: 'nearest' })
}
function moveStep(id: string, offset: number) {
  const index = draft.findIndex(step => step.id === id), target = index + offset
  if (target < 0 || target >= draft.length) return
  const next = [...draft]; [next[index], next[target]] = [next[target], next[index]]; alterSteps(next)
}
function inputField(label: string, key: 'selector' | 'value' | 'ms', step: SdtStep) {
  const wrapper = make('label', '', label)
  const input = make('input'); input.dataset.field = key
  input.type = key === 'ms' ? 'number' : 'text'; input.spellcheck = false
  if (key === 'ms') { input.min = '0'; input.max = '30000'; input.step = '100' }
  else { input.maxLength = key === 'selector' ? 2000 : 10000; input.placeholder = key === 'selector' ? '#element vagy [data-testid="..."]' : step.kind === 'url' ? 'https://pelda.hu/' : step.value === undefined ? 'Kézzel add meg' : 'Beírandó szöveg' }
  input.oninput = () => updateDraft(step.id, key === 'ms' ? { ms: Number(input.value) } : { [key]: input.value })
  input.onchange = () => void syncDraft()
  wrapper.append(input); return wrapper
}
function createStepElement(step: SdtStep) {
  const row = make('li', 'step'), heading = make('div', 'step-heading')
  row.dataset.kind = step.kind
  const number = make('span', 'step-index'), kind = make('select')
  kind.setAttribute('aria-label', 'Lépés típusa')
  for (const [value, label] of [['click', 'Kattintás'], ['input', 'Szövegbevitel'], ['wait', 'Várakozás'], ['url', 'URL-ellenőrzés']]) {
    const option = make('option', '', label); option.value = value; kind.append(option)
  }
  kind.value = step.kind
  kind.onchange = () => {
    const replacement: SdtStep = { id: step.id, kind: kind.value as SdtStep['kind'] }
    if (replacement.kind === 'wait') replacement.ms = 500
    if (replacement.kind === 'url') replacement.value = state?.url ?? ''
    if (replacement.kind === 'click' || replacement.kind === 'input') replacement.selector = ''
    if (replacement.kind === 'input') replacement.value = ''
    alterSteps(draft.map(entry => entry.id === step.id ? replacement : entry))
  }
  heading.append(number, kind)
  for (const [name, label, callback] of [
    ['arrow-up', 'Lépés feljebb', () => moveStep(step.id, -1)],
    ['arrow-down', 'Lépés lejjebb', () => moveStep(step.id, 1)],
    ['trash-2', 'Lépés törlése', () => alterSteps(draft.filter(entry => entry.id !== step.id))],
  ] as const) {
    const control = button('', callback, 'icon-button'); control.title = label; control.setAttribute('aria-label', label); control.dataset.action = name; control.append(icon(name)); heading.append(control)
  }
  row.append(heading)
  if (step.kind === 'click' || step.kind === 'input') row.append(inputField('CSS-lokátor', 'selector', step))
  if (step.kind === 'input') row.append(inputField('Szöveg', 'value', step))
  if (step.kind === 'wait') row.append(inputField('Várakozás (ms)', 'ms', step))
  if (step.kind === 'url') row.append(inputField('Elvárt URL', 'value', step))
  const result = make('div', 'step-result'); result.setAttribute('role', 'status'); row.append(result)
  return row
}
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
      const key = input.dataset.field as 'selector' | 'value' | 'ms', value = String(step[key] ?? '')
      if (document.activeElement !== input && input.value !== value) input.value = value
    }
    for (const input of Array.from(row.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))) input.disabled = busy
    row.querySelector<HTMLButtonElement>('[data-action="arrow-up"]')!.disabled = busy || index === 0
    row.querySelector<HTMLButtonElement>('[data-action="arrow-down"]')!.disabled = busy || index === draft.length - 1
    const result = results.get(step.id)
    row.dataset.status = result?.status ?? ''
    row.querySelector('.step-result')!.textContent = result ? `${({ running: 'Folyamatban…', passed: 'Sikeres', failed: 'Hiba', cancelled: 'Megszakítva' })[result.status]}${result.message ? ` · ${result.message}` : ''}` : ''
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
  $<HTMLButtonElement>('test-save').disabled = !hasSite || busy || !draft.length
  $<HTMLButtonElement>('test-new').disabled = busy
  $<HTMLButtonElement>('test-delete').disabled = busy || !testId
  $<HTMLSelectElement>('saved-tests').disabled = busy
  $<HTMLInputElement>('test-name').disabled = busy
  $<HTMLButtonElement>('api-send').disabled = next.apiRunning
  $('api-cancel').hidden = !next.apiRunning
  $('api-send').title = next.apiRunning ? 'Kérés folyamatban…' : 'Kérés küldése'
  renderSelection(); renderResponse(); renderSavedTests(); renderSteps()
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
$<HTMLSelectElement>('step-add').onchange = () => { const select = $<HTMLSelectElement>('step-add'); if (select.value) addStep(select.value as SdtStep['kind']); select.value = '' }
$('record').onclick = async () => { if (await syncDraft()) void command('record-start') }
$('run').onclick = async () => { if (await syncDraft()) void command('test-run', { steps: draft }) }
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
  if (await command('test-save', { ...(testId ? { id: testId } : {}), name, steps: draft })) {
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
addHeader(); $<HTMLTextAreaElement>('api-body').disabled = true
bridge.onState(render); void command('state'); renderIcons()
