import { performance } from 'node:perf_hooks'
import type { SdtApiRequest, SdtApiResult } from './sdt-types'

const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 20_000
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const TRANSPORT_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'te', 'trailer', 'proxy-authorization', 'proxy-connection', 'expect'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function httpUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Adj meg egy érvényes HTTP(S) webcímet.')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Adj meg egy érvényes HTTP(S) webcímet.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Csak HTTP(S) cím használható, a hitelesítést fejlécben add meg.')
  url.hash = ''
  return url
}

function validate(input: unknown): { url: URL; method: SdtApiRequest['method']; headers: Headers; body?: string } {
  if (!input || typeof input !== 'object') throw new Error('Érvénytelen API-kérés.')
  const request = input as Record<string, unknown>
  const url = httpUrl(request.url)
  if (typeof request.method !== 'string' || !METHODS.has(request.method)) throw new Error('Nem támogatott HTTP-metódus.')
  if (!Array.isArray(request.headers) || request.headers.length > 64) throw new Error('Legfeljebb 64 kérésfejléc adható meg.')
  const headers = new Headers()
  let headerBytes = 0
  for (const entry of request.headers) {
    if (!entry || typeof entry !== 'object') throw new Error('Érvénytelen fejléc.')
    const { name, value } = entry as Record<string, unknown>
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Érvénytelen fejlécnév vagy fejlécérték.')
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) throw new Error(`A(z) ${name} fejlécet a hálózati kliens kezeli.`)
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
    if (headerBytes > 32768) throw new Error('A kérésfejlécek összesen legfeljebb 32 KB méretűek lehetnek.')
    headers.append(name, value)
  }
  if (typeof request.body !== 'string' || Buffer.byteLength(request.body) > MAX_BYTES) throw new Error('A kérés törzse legfeljebb 1 MB méretű lehet.')
  if (request.bodyType !== 'json' && request.bodyType !== 'text') throw new Error('Érvénytelen törzstípus.')
  const method = request.method as SdtApiRequest['method']
  if ((method === 'GET' || method === 'HEAD') && request.body.trim()) throw new Error('GET és HEAD kéréshez nem adható törzs.')
  const body = method === 'GET' || method === 'HEAD' || !request.body ? undefined : request.body
  if (body !== undefined) {
    if (request.bodyType === 'json') {
      try { JSON.parse(body) } catch { throw new Error('A kérés törzse nem érvényes JSON.') }
    }
    if (!headers.has('content-type')) headers.set('content-type', request.bodyType === 'json' ? 'application/json' : 'text/plain; charset=utf-8')
  }
  return { url, method, headers, body }
}

/** Runs outside Chromium: no browser cookie jar, HTTP cache or stored credentials. */
export async function requestApi(input: unknown, signal: AbortSignal): Promise<SdtApiResult> {
  const start = performance.now()
  const result: SdtApiResult = { status: 0, statusText: '', elapsedMs: 0, headers: [], body: '', bytes: 0 }
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, TIMEOUT_MS)
  const chunks: Buffer[] = []
  try {
    let { url, method, headers, body } = validate(input)
    for (let redirects = 0; ; redirects++) {
      controller.signal.throwIfAborted()
      const response = await fetch(url, { method, headers, body, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal })
      if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        await response.body?.cancel()
        if (redirects >= 5) throw new Error('Túl sok átirányítás (legfeljebb 5 engedélyezett).')
        const next = httpUrl(new URL(response.headers.get('location')!, url).href)
        if (next.origin !== url.origin) {
          // Custom API keys may use any header name; never forward them to another origin.
          const publicHeaders = new Headers()
          for (const name of ['accept', 'content-type']) {
            const value = headers.get(name)
            if (value !== null) publicHeaders.set(name, value)
          }
          headers = publicHeaders
        }
        if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
          method = 'GET'
          body = undefined
          headers.delete('content-type')
          headers.delete('content-encoding')
        }
        url = next
        continue
      }
      result.status = response.status
      result.statusText = response.statusText.slice(0, 200)
      result.headers = Array.from(response.headers.entries()).slice(0, 200).map(([name, value]) => ({ name, value: value.slice(0, 8192) }))
      if (response.body) {
        const reader = response.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const remaining = MAX_BYTES - result.bytes
            if (value.byteLength > remaining) {
              if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)))
              result.bytes = MAX_BYTES
              await reader.cancel()
              throw new Error('A válasz meghaladja az 1 MB-os korlátot; csak az eleje jelenik meg.')
            }
            chunks.push(Buffer.from(value))
            result.bytes += value.byteLength
          }
        } finally { reader.releaseLock() }
      }
      break
    }
  } catch (error) {
    result.error = timedOut ? 'Az API-kérés túllépte a 20 másodperces időkorlátot.' : signal.aborted ? 'Az API-kérés megszakítva.' : error instanceof Error ? error.message.slice(0, 500) : 'Az API-kérés nem sikerült.'
    // Ensure a failed/oversized response cannot keep transferring in the background.
    controller.abort()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    result.body = Buffer.concat(chunks, result.bytes).toString('utf8')
    result.elapsedMs = Math.round(performance.now() - start)
  }
  return result
}
