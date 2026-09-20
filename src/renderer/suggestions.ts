import './suggestions.css'

type Row = { label: string; detail: string; value: string }
type State = { suggestionsPopup: { rows: Row[]; selected: number } | null }
type Bridge = { command: (action: string, value?: string) => Promise<unknown>; onState: (callback: (state: State) => void) => () => void }
const bridge = (window as unknown as { browser: Bridge }).browser
const root = document.getElementById('suggestions')!
let signature = ''

function render(state: State) {
  const popup = state.suggestionsPopup
  const next = JSON.stringify(popup)
  if (next === signature) return
  signature = next
  root.replaceChildren()
  if (!popup) return
  popup.rows.forEach((row, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = index === popup.selected ? 'selected' : ''
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', String(index === popup.selected))
    const label = document.createElement('strong'); label.textContent = row.label
    const detail = document.createElement('span'); detail.textContent = row.detail
    button.append(label, detail)
    button.addEventListener('pointerdown', event => { event.preventDefault(); void bridge.command('suggestion-choose', String(index)) })
    root.append(button)
  })
}

bridge.onState(render)
void bridge.command('state').then(value => { if (value && typeof value === 'object') render(value as State) })
