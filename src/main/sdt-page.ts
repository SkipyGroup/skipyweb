import type { SdtSelection, SdtStep } from './sdt-types'

// This world has no preload or Node bindings and shares only the document with the page.
export const SDT_WORLD_ID = 19731

export type SdtPageCommand =
  | { kind: 'install'; token: string; mode: 'picking' | 'recording'; binding?: string }
  | { kind: 'poll' | 'stop'; token: string }
  | { kind: 'locate' | 'prepare-input' | 'read-input' | 'inspect'; selector: string }
  | {kind:'set-control';selector:string;value:string}
  | {kind:'dom-click';selector:string}

export type SdtPageEvent =
  | { kind: 'selection'; selection: SdtSelection }
  | { kind: 'step'; step: Omit<SdtStep, 'id'>; at: number; eventId: string }
  | { kind: 'message'; message: string }
  | { kind: 'stopped'; message: string }

export type SdtPageReply = {
  events?: SdtPageEvent[]
  alive?: boolean
  x?: number
  y?: number
  value?: string
  visible?: boolean
  checked?:boolean
  error?: string
}

// Keep this function self-contained: its compiled source runs in the isolated world.
function pageCommand(command: SdtPageCommand): SdtPageReply {
  type Session = {
    token: string
    mode: 'picking' | 'recording'
    events: SdtPageEvent[]
    cleanup: () => void
    flush: () => void
    stopped: boolean
    binding?: string
    eventSequence: number
  }
  const globals = globalThis as typeof globalThis & { __skipySdtSession?: Session }

  function uniqueSelector(element: Element): string {
    if (element.getRootNode() !== document) throw new Error('A Shadow DOM elemei ebben a verzióban nem támogatottak.')
    const unique = (selector: string) => document.querySelectorAll(selector).length === 1
    const attribute = (name: string, value: string) => `[${name}="${CSS.escape(value)}"]`
    for (const name of ['data-testid', 'data-test', 'data-qa']) {
      const value = element.getAttribute(name)
      if (value) { const selector = attribute(name, value); if (unique(selector)) return selector }
    }
    if (element.id) { const selector = `#${CSS.escape(element.id)}`; if (unique(selector)) return selector }
    for (const name of ['name', 'aria-label']) {
      const value = element.getAttribute(name)
      if (value) {
        const selector = `${CSS.escape(element.localName)}${attribute(name, value)}`
        if (unique(selector)) return selector
      }
    }
    const parts: string[] = []
    let node: Element | null = element
    while (node && parts.length < 24) {
      let part = CSS.escape(node.localName)
      const parent: Element | null = node.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(sibling => sibling.localName === node!.localName)
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (unique(selector)) return selector
      node = parent
    }
    throw new Error('Az elemhez nem készíthető egyedi CSS-lokátor.')
  }

  function pickedElement(event: Event): Element | null {
    const node = event.composedPath().find(value => value instanceof Element)
    return node instanceof Element ? node : null
  }

  function locate(selector: string): Element {
    if (!selector || selector.length > 2048) throw new Error('Hiányzó vagy túl hosszú CSS-lokátor.')
    let matches: NodeListOf<Element>
    try { matches = document.querySelectorAll(selector) } catch { throw new Error('Érvénytelen CSS-lokátor.') }
    if (!matches.length) throw new Error('Az elem még nem található az oldalon.')
    if (matches.length !== 1) throw new Error('A lokátor több elemre illeszkedik; adj meg egyedi lokátort.')
    const element = matches[0]
    if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
      throw new Error('Beágyazott keret elemei ebben a verzióban nem tesztelhetők.')
    }
    return element
  }

  function targetPoint(element: Element): { x: number; y: number } {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) throw new Error('Az elem nem látható.')
    if (element.matches(':disabled') || element.closest('[inert]')) throw new Error('Az elem nem használható.')
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const bounds = element.getBoundingClientRect()
    const left = Math.max(0, bounds.left), right = Math.min(innerWidth, bounds.right)
    const top = Math.max(0, bounds.top), bottom = Math.min(innerHeight, bounds.bottom)
    if (right - left < 1 || bottom - top < 1) throw new Error('Az elemnek nincs látható kattintási területe.')
    const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2)
    const hit = document.elementFromPoint(x, y)
    if (!hit || !(hit === element || element.contains(hit))) throw new Error('Az elemet egy másik elem takarja.')
    return { x, y }
  }

  function editable(element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
    if (element instanceof HTMLInputElement) return ['text', 'email', 'url', 'tel', 'search', 'password', 'number'].includes(element.type) && !element.readOnly && !element.disabled
    if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled
    return element instanceof HTMLElement && element.isContentEditable
  }

  function inputValue(element: Element): string {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent || ''
  }

  try {
    if(command.kind==='set-control'){
      const element=locate(command.selector)
      if(element instanceof HTMLSelectElement){element.value=command.value;element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return {value:element.value}}
      if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)){element.checked=command.value==='true';element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return {value:String(element.checked),checked:element.checked}}
      throw new Error('A cél nem select, checkbox vagy rádiógomb.')
    }
    if(command.kind==='dom-click'){const element=locate(command.selector);if(!(element instanceof HTMLElement))throw new Error('Az elem nem kattintható.');targetPoint(element);element.click();return {alive:true}}
    if (command.kind === 'locate' || command.kind === 'prepare-input' || command.kind === 'read-input' || command.kind === 'inspect') {
      const element = locate(command.selector)
      if (command.kind === 'inspect') { const style=getComputedStyle(element),rect=element.getBoundingClientRect();const value=element instanceof HTMLSelectElement?element.value:element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type)?String(element.checked):inputValue(element).trim();return { value,checked:element instanceof HTMLInputElement?element.checked:undefined, visible:style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0&&rect.width>0&&rect.height>0 } }
      if (command.kind === 'locate') return targetPoint(element)
      if (!editable(element)) throw new Error('A kijelölt elem nem írható szövegmező.')
      if (command.kind === 'read-input') return { value: inputValue(element) }
      const point = targetPoint(element)
      element.focus({ preventScroll: true })
      if (document.activeElement !== element) throw new Error('A szövegmező nem kaphat fókuszt.')
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        try { element.select() } catch { /* Chromium selectAll handles number inputs. */ }
      } else {
        const selection = window.getSelection(), range = document.createRange()
        range.selectNodeContents(element)
        selection?.removeAllRanges(); selection?.addRange(range)
      }
      return point
    }

    if (command.kind === 'poll' || command.kind === 'stop') {
      const session = globals.__skipySdtSession
      if (!session || session.token !== command.token) return { alive: false, events: [] }
      if (command.kind === 'stop') { session.flush(); session.cleanup(); session.stopped = true }
      const events = session.events.splice(0)
      const alive = !session.stopped
      if (!alive) delete globals.__skipySdtSession
      return { alive, events }
    }

    if (command.kind !== 'install') throw new Error('Ismeretlen SDT oldalművelet.')
    if (!document.documentElement) throw new Error('Az oldal dokumentuma még nem áll készen.')
    globals.__skipySdtSession?.cleanup()
    const session: Session = { token: command.token, mode: command.mode, events: [], cleanup: () => {}, flush: () => {}, stopped: false, binding: command.binding, eventSequence: 0 }
    globals.__skipySdtSession = session
    const removers: Array<() => void> = []
    let inputTimer: ReturnType<typeof setTimeout> | undefined
    let pendingInput: Extract<SdtPageEvent, { kind: 'step' }> | null = null
    let lastPasswordSelector = ''
    let frame = 0
    let host: HTMLDivElement | null = null
    let highlight: HTMLDivElement | null = null
    let caption: HTMLDivElement | null = null

    function push(event: SdtPageEvent) {
      if (session.stopped) return
      if (session.events.length >= 100) {
        session.events.splice(99)
        session.events.push({ kind: 'stopped', message: 'A rögzítési sor megtelt. A rögzítés leállt.' })
        session.stopped = true; session.cleanup(); return
      }
      session.events.push(event)
      if (event.kind === 'step' && session.binding) {
        const binding = (globals as unknown as Record<string, unknown>)[session.binding]
        if (typeof binding === 'function') {
          try { (binding as (payload: string) => void)(JSON.stringify({ token: session.token, event })) } catch { /* Polling remains the fallback. */ }
        }
      }
    }
    const step = (value: Omit<SdtStep, 'id'>): Extract<SdtPageEvent, { kind: 'step' }> => ({ kind: 'step', step: value, at: Date.now(), eventId: `${Date.now().toString(36)}-${++session.eventSequence}` })
    function listen(type: string, handler: EventListener) {
      window.addEventListener(type, handler, true)
      removers.push(() => window.removeEventListener(type, handler, true))
    }
    session.flush = () => {
      if (inputTimer) clearTimeout(inputTimer)
      inputTimer = undefined
      if (pendingInput) push(pendingInput)
      pendingInput = null
    }
    session.cleanup = () => {
      if (inputTimer) clearTimeout(inputTimer)
      if (frame) cancelAnimationFrame(frame)
      for (const remove of removers.splice(0)) remove()
      host?.remove(); host = null; highlight = null; caption = null
    }
    const end = (message: string) => {
      session.flush(); push({ kind: 'stopped', message }); session.stopped = true; session.cleanup()
    }
    listen('keydown', event => {
      const keyboard = event as KeyboardEvent
      if (keyboard.isTrusted && keyboard.key === 'Escape') {
        keyboard.preventDefault(); keyboard.stopImmediatePropagation(); end('Az SDT művelet leállt.')
      }
    })
    listen('pagehide', () => end('A dokumentum elhagyása leállította az SDT műveletet.'))

    if (command.mode === 'picking') {
      host = document.createElement('div')
      host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:strict!important;'
      const shadow = host.attachShadow({ mode: 'closed' })
      highlight = document.createElement('div')
      highlight.style.cssText = 'position:absolute;display:none;box-sizing:border-box;border:2px solid #ff6600;background:#ff660022;box-shadow:0 0 0 1px #0009;pointer-events:none;'
      caption = document.createElement('div')
      caption.style.cssText = 'position:absolute;max-width:70vw;padding:5px 8px;border:1px solid #ff6600;border-radius:5px;background:#121212;color:#fff;font:12px/1.4 monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;pointer-events:none;'
      caption.textContent = 'SDT színválasztó · Kattints egy elemre · Esc: mégse'
      caption.style.left = '10px'; caption.style.top = '10px'
      shadow.append(highlight, caption); document.documentElement.append(host)
      listen('pointermove', event => {
        if (frame || session.stopped) return
        const element = pickedElement(event)
        frame = requestAnimationFrame(() => {
          frame = 0
          if (!element || !highlight || !caption) return
          const rect = element.getBoundingClientRect()
          highlight.style.display = 'block'
          highlight.style.left = `${rect.left}px`; highlight.style.top = `${rect.top}px`
          highlight.style.width = `${rect.width}px`; highlight.style.height = `${rect.height}px`
          caption.textContent = `${element.localName}${element.id ? `#${element.id}` : ''} · Kattintás: színek · Esc: mégse`
          caption.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - Math.min(520, innerWidth * .7) - 8))}px`
          caption.style.top = `${Math.max(8, Math.min(innerHeight - 40, rect.top > 40 ? rect.top - 32 : rect.bottom + 6))}px`
        })
      })
      const prevent = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) listen(type, prevent)
      listen('click', event => {
        prevent(event)
        if (!event.isTrusted) return
        const element = pickedElement(event)
        if (!element) return
        try {
          if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) throw new Error('A beágyazott keret tartalmának kiválasztása nem támogatott.')
          const selector = uniqueSelector(element), style = getComputedStyle(element)
          const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
          const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })
          const color = (label: string, css: string) => {
            let values: number[] | null = null
            const match = css.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/)
            if (match) values = [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])]
            else if (context && CSS.supports('color', css)) {
              context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1)
              const pixel = context.getImageData(0, 0, 1, 1).data
              values = [pixel[0], pixel[1], pixel[2], pixel[3] / 255]
            }
            if (!values) return { label, css, hex: null, rgb: null }
            const [r, g, b] = values.slice(0, 3).map(value => Math.min(255, Math.max(0, Math.round(value))))
            const alpha = Math.min(1, Math.max(0, values[3]))
            const hex = '#' + [r, g, b, ...(alpha < 1 ? [Math.round(alpha * 255)] : [])].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase()
            const rgb = alpha < 1 ? `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(4))})` : `rgb(${r}, ${g}, ${b})`
            return { label, css, hex, rgb }
          }
          push({ kind: 'selection', selection: { selector, typography: { fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight }, colors: [
            color('Háttér', style.backgroundColor), color('Szöveg', style.color),
            color('Felső keret', style.borderTopColor), color('Jobb keret', style.borderRightColor),
            color('Alsó keret', style.borderBottomColor), color('Bal keret', style.borderLeftColor),
          ] } })
          end('Az elem színei kiválasztva.')
        } catch (error) { push({ kind: 'message', message: error instanceof Error ? error.message : 'Az elem nem választható ki.' }) }
      })
    } else {
      const labelFor=(element:Element,action:string)=>{const label=element.getAttribute('aria-label')||element.getAttribute('name')||element.id||(element.textContent||'').trim().slice(0,60);return `${action}: ${label||element.localName}`}
      listen('click', event => {
        const mouse = event as MouseEvent
        if (!mouse.isTrusted || mouse.button !== 0 || mouse.ctrlKey || mouse.metaKey || mouse.altKey) return
        const original = pickedElement(event)
        if (!original) return
        session.flush()
        try {
          const element = original.closest('button, a, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]') || original
          if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type))return
          if(element instanceof HTMLSelectElement)return
          push(step({ kind: 'click',name:labelFor(element,'Kattintás'), selector: uniqueSelector(element), x: Math.round(mouse.clientX), y: Math.round(mouse.clientY) }))
        } catch (error) { push({ kind: 'message', message: error instanceof Error ? error.message : 'A kattintás nem rögzíthető.' }) }
      })
      listen('input', event => {
        if (!event.isTrusted) return
        const element = pickedElement(event)
        if (!element || !editable(element)) return
        try {
          const selector = uniqueSelector(element)
          if (element instanceof HTMLInputElement && element.type === 'password') {
            if (lastPasswordSelector !== selector) {
              session.flush(); lastPasswordSelector = selector
              push(step({ kind: 'input', selector, sensitive: true }))
              push({ kind: 'message', message: 'A jelszó tartalmát nem rögzítjük. A bemeneti lépés értékét kézzel add meg futtatás előtt.' })
            }
            return
          }
          lastPasswordSelector = ''
          const value = inputValue(element)
          if (value.length > 10000) { push({ kind: 'message', message: 'A 10 000 karakternél hosszabb mezőérték nem rögzíthető.' }); return }
          if (pendingInput && pendingInput.step.selector !== selector) session.flush()
          pendingInput = step({ kind: 'input',name:labelFor(element,'Bevitel'), selector, value })
          if (inputTimer) clearTimeout(inputTimer)
          inputTimer = setTimeout(session.flush, 300)
        } catch (error) { push({ kind: 'message', message: error instanceof Error ? error.message : 'A bevitel nem rögzíthető.' }) }
      })
      listen('change',event=>{if(!event.isTrusted)return;const element=pickedElement(event);if(!element)return;try{session.flush();const selector=uniqueSelector(element);if(element instanceof HTMLSelectElement)push(step({kind:'select',name:labelFor(element,'Választás'),selector,value:element.value,expectedValue:element.value}));else if(element instanceof HTMLInputElement&&['checkbox','radio'].includes(element.type))push(step({kind:'check',name:labelFor(element,'Állapot'),selector,value:String(element.checked),expectedValue:String(element.checked)}))}catch(error){push({kind:'message',message:error instanceof Error?error.message:'A mezőváltozás nem rögzíthető.'})}})
      listen('keydown',event=>{const key=event as KeyboardEvent;if(!key.isTrusted||key.key==='Escape'||(!key.ctrlKey&&!key.altKey&&!key.metaKey&&!['Enter','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key.key)))return;session.flush();const parts=[key.ctrlKey?'Ctrl':'',key.altKey?'Alt':'',key.shiftKey?'Shift':'',key.metaKey?'Meta':'',key.key].filter(Boolean);push(step({kind:'key',name:`Billentyű: ${parts.join('+')}`,value:parts.join('+')}))})
      listen('blur', () => session.flush())
      // Frame documents have separate event trees. Surface that boundary instead of claiming a complete recording.
      listen('blur', () => {
        setTimeout(() => {
          if (!session.stopped && (document.activeElement instanceof HTMLIFrameElement || document.activeElement instanceof HTMLFrameElement)) {
            push({ kind: 'message', message: 'A beágyazott keretben végzett műveleteket az SDT ebben a verzióban nem rögzíti.' })
          }
        }, 0)
      })
    }
    return { alive: true, events: [] }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Az SDT oldalművelet sikertelen.' }
  }
}

export function sdtPageScript(command: SdtPageCommand): string {
  return `(${pageCommand.toString()})(${JSON.stringify(command)})`
}
