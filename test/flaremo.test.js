import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FlareMoClient } from '../packages/knowledge/flaremo.js';
import { startMock } from '../apps/flaremo-demo/mock-server.js';
import { runMockDemo, runScenario } from '../apps/flaremo-demo/scenario.js';
import { startUi } from '../apps/flaremo-demo/server.js';

async function fixture(t) {
  const mock = await startMock(); t.after(mock.close);
  const writer = new FlareMoClient({ baseUrl: mock.baseUrl, token: mock.writerToken, allowWrite: true, allowLocal: true });
  const reader = new FlareMoClient({ baseUrl: mock.baseUrl, token: mock.readerToken, allowLocal: true });
  return { mock, writer, reader };
}

test('HTTP mock exercises sharing, fresh reads, withdrawal, token revocation and trash', async () => {
  const report = await runMockDemo();
  assert.equal(report.status, 'passed');
  assert.equal(report.mode, 'local-http-mock');
  assert.equal(report.steps.length, 8);
  assert.ok(report.steps.every(step => step.status === 'passed'));
});

test('write methods are disabled by default and cannot create a memo', async t => {
  const { reader } = await fixture(t);
  await assert.rejects(reader.create('synthetic'), /WRITE_NOT_ENABLED/);
  await assert.rejects(reader.update('memos/example', { content: 'synthetic' }), /WRITE_NOT_ENABLED/);
  await assert.rejects(reader.trash('memos/example'), /WRITE_NOT_ENABLED/);
});

test('ordinary reader cannot edit or trash another member shared resource', async t => {
  const { mock, writer } = await fixture(t);
  const memo = await writer.create('synthetic');
  await writer.update(memo.name, { visibility: 'PROTECTED' });
  const readerWithWrite = new FlareMoClient({ baseUrl: mock.baseUrl, token: mock.readerToken, allowLocal: true, allowWrite: true });
  await assert.rejects(readerWithWrite.update(memo.name, { content: 'changed' }), error => error.status === 403);
  await assert.rejects(readerWithWrite.trash(memo.name), error => error.status === 403);
  assert.equal((await writer.get(memo.name)).content, 'synthetic');
});

test('resource path and base URL checks keep credentials on the configured instance', async t => {
  const { writer } = await fixture(t);
  for (const name of ['../admin', 'https://elsewhere.example/memos/a', 'memos/a?force=true', 'memos/a/b', 'memos/%2e%2e']) {
    await assert.rejects(writer.get(name), /INVALID_MEMO_NAME/);
  }
  await assert.rejects(writer.request('GET', 'https://elsewhere.example/api/v1/memos/a'), /INVALID_RESOURCE_URL/);
  for (const baseUrl of ['http://example.com', 'https://example.com/subpath', 'https://example.com/?token=x', 'https://user:password@example.com']) {
    assert.throws(() => new FlareMoClient({ baseUrl, token: 'synthetic' }), /INVALID_BASE_URL/);
  }
});

test('failed scenario restores its own test memo to private', async t => {
  const { writer } = await fixture(t);
  const reader = { get: () => { throw new Error('synthetic injected failure'); } };
  const report = await runScenario({ writer, reader, mode: 'injected-failure' });
  assert.equal(report.status, 'failed');
  assert.equal((await writer.get(report.memoName)).visibility, 'PRIVATE');
  assert.equal(report.steps.at(-1).error, 'UNEXPECTED_ERROR');
});

async function transportFixture(t, handler, timeoutMs = 1000) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return new FlareMoClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-sensitive-value', allowLocal: true, timeoutMs });
}

test('HTTP failures do not expose bodies or credentials', async t => {
  const client = await transportFixture(t, (_req, res) => { res.writeHead(401); res.end('synthetic-sensitive-value'); });
  await assert.rejects(client.get('memos/a'), error => error.status === 401 && !error.message.includes('synthetic-sensitive-value'));
});

test('redirects are refused rather than forwarding credentials', async t => {
  const client = await transportFixture(t, (_req, res) => { res.writeHead(302, { location: 'https://example.com/' }); res.end(); });
  await assert.rejects(client.get('memos/a'), /TRANSPORT_ERROR/);
});

test('malformed success responses fail clearly', async t => {
  const client = await transportFixture(t, (_req, res) => { res.writeHead(200); res.end('<html>sign in</html>'); });
  await assert.rejects(client.get('memos/a'), /INVALID_JSON_RESPONSE/);
});

test('stalled requests time out', async t => {
  const client = await transportFixture(t, () => {}, 50);
  await assert.rejects(client.get('memos/a'), /REQUEST_TIMEOUT/);
});

test('local viewer runs only the synthetic scenario and rejects foreign origins', async t => {
  const ui = await startUi(0); t.after(ui.close);
  const page = await fetch(ui.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /本地 HTTP 模拟/);
  const rejected = await fetch(`${ui.url}/api/run`, { method: 'POST', headers: { origin: 'https://example.com' } });
  assert.equal(rejected.status, 403);
  const result = await fetch(`${ui.url}/api/run`, { method: 'POST', headers: { origin: ui.url } });
  assert.equal((await result.json()).status, 'passed');
});
