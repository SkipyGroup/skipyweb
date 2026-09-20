const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SdtStore, validateSteps } = require('../dist-main/sdt-store.js')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skipy-sdt-test-'))
  // Only remove the exact temporary directory returned by mkdtemp for this test.
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'sdt.json')
  const store = new SdtStore(file)
  store.load()
  return { store, file, directory }
}
function draft(name = 'Local test') { return { name, steps: [{ id: 'wait-1', kind: 'wait', ms: 10 }] } }

test('store persists concurrent updates atomically and isolates sites', async t => {
  const { store, file, directory } = await fixture(t)
  await fs.writeFile(path.join(directory, 'library.json'), '{"bookmarks":["untouched"]}')
  const created = await Promise.all(Array.from({ length: 10 }, (_, index) => store.save(index % 2 ? 'example.com' : 'localhost', draft(`Test ${index}`))))
  await store.flush()
  const reopened = new SdtStore(file)
  reopened.load()
  assert.equal(reopened.list('example.com').length, 5)
  assert.equal(reopened.list('localhost').length, 5)
  assert.equal(reopened.list(null).length, 0)
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1)
  assert.equal(await fs.readFile(path.join(directory, 'library.json'), 'utf8'), '{"bookmarks":["untouched"]}')
  assert.deepEqual((await fs.readdir(directory)).sort(), ['library.json', 'sdt.json'])
  const value = reopened.list('localhost')[0]
  value.steps[0].ms = 999
  assert.equal(reopened.list('localhost')[0].steps[0].ms, 10)
  await assert.rejects(reopened.save('example.com', { ...draft(), id: created[0].id }), /Másik webhely/)
  await reopened.remove('example.com', created[0].id)
  assert.equal(reopened.list('localhost').length, 5)
  await reopened.remove('localhost', created[0].id)
  assert.equal(reopened.list('localhost').length, 4)
})

test('50-test limit applies globally, updates and deletions free no phantom slots', async t => {
  const { store } = await fixture(t)
  const entries = await Promise.all(Array.from({ length: 50 }, (_, index) => store.save('example.com', draft(`Test ${index}`))))
  await assert.rejects(store.save('localhost', draft()), /50 teszt/)
  await store.save('example.com', { ...draft('Edited'), id: entries[0].id })
  assert.equal(store.list('example.com').length, 50)
  await store.remove('example.com', entries[0].id)
  await store.save('localhost', draft())
  assert.equal(store.list('localhost').length, 1)
})

test('damaged or newer data is preserved and refuses destructive replacement', async t => {
  const { file } = await fixture(t)
  for (const source of ['{broken', '{"version":9,"tests":[]}']) {
    await fs.writeFile(file, source)
    const store = new SdtStore(file)
    store.load()
    assert.deepEqual(store.list('localhost'), [])
    await assert.rejects(store.save('localhost', draft()), /megőrzése/)
    assert.equal(await fs.readFile(file, 'utf8'), source)
  }
})

test('input placeholders survive persistence without recorded password text', async t => {
  const { store, file } = await fixture(t)
  const result = await store.save('localhost', { name: 'Login', steps: [{ id: 'password', kind: 'input', selector: '#password' }] })
  assert.equal(Object.hasOwn(result.steps[0], 'value'), false)
  const reopened = new SdtStore(file)
  reopened.load()
  assert.equal(Object.hasOwn(reopened.list('localhost')[0].steps[0], 'value'), false)
})

test('validation bounds steps, waits, selectors, text, coordinates and URL assertions', () => {
  assert.deepEqual(validateSteps([]), [])
  for (const steps of [
    Array.from({ length: 101 }, (_, i) => ({ id: `wait-${i}`, kind: 'wait', ms: 0 })),
    [{ id: 'one', kind: 'wait', ms: 30001 }],
    [{ id: 'one', kind: 'wait', ms: NaN }],
    [{ id: 'one', kind: 'click', selector: '#ok', x: -1, y: 10 }],
    [{ id: 'one', kind: 'click', selector: 'x'.repeat(2049) }],
    [{ id: 'one', kind: 'input', selector: '#ok', value: 'x'.repeat(10001) }],
    [{ id: 'one', kind: 'url', value: 'javascript:alert(1)' }],
    [{ id: 'one', kind: 'wait', ms: 0 }, { id: 'one', kind: 'wait', ms: 0 }],
  ]) assert.throws(() => validateSteps(steps))
})
