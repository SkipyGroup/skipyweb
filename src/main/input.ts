export function classifyInput(input: string): 'home' | 'url' | 'search' {
  const value = input.trim()
  if (!value) return 'home'
  if (/^https?:\/\//i.test(value)) {
    try { new URL(value); return 'url' } catch { return 'search' }
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value)) return 'url'
  if (/^[^\s./]+(\.[^\s/]+)+(\/[^\s]*)?$/i.test(value)) {
    try { new URL(`https://${value}`); return 'url' } catch { return 'search' }
  }
  return 'search'
}

export function resolveInput(input: string, engine: 'google' | 'duckduckgo' | 'bing'): string {
  const value = input.trim()
  const kind = classifyInput(value)
  if (kind === 'home') return 'skipy://home'
  if (kind === 'url') return /^https?:\/\//i.test(value) ? new URL(value).toString() : new URL(`${/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(value) ? 'http' : 'https'}://${value}`).toString()
  const query = encodeURIComponent(value)
  if (engine === 'duckduckgo') return `https://duckduckgo.com/?q=${query}`
  if (engine === 'bing') return `https://www.bing.com/search?q=${query}`
  return `https://www.google.com/search?q=${query}`
}
