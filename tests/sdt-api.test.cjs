const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { gzipSync } = require('node:zlib')
const { requestApi } = require('../dist-main/sdt-api.js')

async function fixture(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${server.address().port}`
}
function input(url, overrides = {}) {
  return { url, method: 'GET', headers: [], body: '', bodyType: 'text', ...overrides }
}
function send(request, signal = new AbortController().signal) { return requestApi(request, signal) }

test('API returns status, custom headers and JSON POST body from a real local endpoint', async t => {
  const origin = await fixture(t, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-response': 'yes' })
      res.end(JSON.stringify({ method: req.method, key: req.headers['x-key'], type: req.headers['content-type'], body: Buffer.concat(chunks).toString() }))
    })
  })
  const result = await send(input(origin, { method: 'POST', body: '{"value":42}', bodyType: 'json', headers: [{ name: 'x-key', value: 'explicit-key' }] }))
  assert.equal(result.error, undefined)
  assert.equal(result.status, 201)
  assert.equal(result.bytes, Buffer.byteLength(result.body))
  assert.ok(result.elapsedMs >= 0)
  assert.ok(result.headers.some(header => header.name === 'x-response' && header.value === 'yes'))
  assert.deepEqual(JSON.parse(result.body), { method: 'POST', key: 'explicit-key', type: 'application/json', body: '{"value":42}' })
})

test('API preserves HTTP errors as usable responses and supports HEAD', async t => {
  const origin = await fixture(t, (req, res) => { res.writeHead(404, { 'x-test': 'found' }); res.end(req.method === 'HEAD' ? undefined : 'missing') })
  const missing = await send(input(origin))
  assert.equal(missing.status, 404)
  assert.equal(missing.body, 'missing')
  assert.equal(missing.error, undefined)
  const head = await send(input(origin, { method: 'HEAD' }))
  assert.equal(head.status, 404)
  assert.equal(head.bytes, 0)
})

test('API does not share a cookie jar across calls', async t => {
  const origin = await fixture(t, (req, res) => {
    res.setHeader('set-cookie', 'private=value; Path=/')
    res.end(req.headers.cookie || 'no-cookie')
  })
  assert.equal((await send(input(origin))).body, 'no-cookie')
  assert.equal((await send(input(origin))).body, 'no-cookie')
})

test('redirects strip every private caller header when the origin changes', async t => {
  const target = await fixture(t, (req, res) => res.end(JSON.stringify(req.headers)))
  const source = await fixture(t, (_req, res) => { res.writeHead(302, { location: `${target}/target` }); res.end() })
  const result = await send(input(source, { headers: [
    { name: 'authorization', value: 'Bearer secret' }, { name: 'x-api-key', value: 'secret' },
    { name: 'cookie', value: 'private=secret' }, { name: 'accept', value: 'application/json' },
  ] }))
  const headers = JSON.parse(result.body)
  assert.equal(headers.authorization, undefined)
  assert.equal(headers['x-api-key'], undefined)
  assert.equal(headers.cookie, undefined)
  assert.equal(headers.accept, 'application/json')
})

test('redirect loop stops and redirects cannot open non HTTP resources', async t => {
  let hits = 0
  const origin = await fixture(t, (req, res) => {
    hits++
    res.writeHead(302, { location: req.url === '/file' ? 'file:///C:/secret.txt' : '/' })
    res.end()
  })
  assert.match((await send(input(origin))).error, /átirányítás/)
  assert.equal(hits, 6)
  assert.match((await send(input(`${origin}/file`))).error, /HTTP/)
})

test('API limits decoded compressed responses to 1 MiB', async t => {
  const payload = gzipSync(Buffer.alloc(1024 * 1024 + 50_000, 65))
  const origin = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(payload) })
  const result = await send(input(origin))
  assert.match(result.error, /1 MB/)
  assert.equal(result.status, 200)
  assert.equal(result.bytes, 1024 * 1024)
  assert.equal(Buffer.byteLength(result.body), 1024 * 1024)
})

test('API abort stops an unfinished response and retains bytes already received', async t => {
  let received
  const firstChunk = new Promise(resolve => { received = resolve })
  const origin = await fixture(t, (_req, res) => { res.write('partial'); received() })
  const controller = new AbortController()
  const request = send(input(origin), controller.signal)
  await firstChunk
  // Let fetch consume the first chunk before exercising streaming cancellation.
  await new Promise(resolve => setTimeout(resolve, 30))
  controller.abort()
  const result = await request
  assert.match(result.error, /megszakítva/)
  assert.equal(result.body, 'partial')
  assert.equal(result.bytes, 7)
})

test('API deadline covers a server that never returns headers', async t => {
  const origin = await fixture(t, () => {})
  const result = await send(input(origin))
  assert.match(result.error, /20 másodperces/)
  assert.ok(result.elapsedMs >= 19_000 && result.elapsedMs < 25_000)
})

test('API rejects invalid schemes, credentials, methods, headers, bodies before a request', async () => {
  const examples = [
    input('file:///C:/secret'), input('http://name:password@127.0.0.1/'),
    input('http://127.0.0.1/', { method: 'CONNECT' }),
    input('http://127.0.0.1/', { headers: [{ name: 'x-test', value: 'a\r\nb' }] }),
    input('http://127.0.0.1/', { headers: [{ name: 'Host', value: 'elsewhere' }] }),
    input('http://127.0.0.1/', { method: 'POST', bodyType: 'json', body: '{oops' }),
    input('http://127.0.0.1/', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }),
    input('http://127.0.0.1/', { method: 'GET', body: 'body' }),
  ]
  for (const request of examples) {
    const result = await send(request)
    assert.ok(result.error)
    assert.equal(result.status, 0)
    assert.equal(result.bytes, 0)
  }
})
