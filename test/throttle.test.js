// The endpoints that answer before anyone has proved who they are. A sign-in
// makes this node ask the identity provider about a token; starting a device
// authorisation makes it write records it then holds for ten minutes. Both are
// work an anonymous caller can ask for, so both are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle, OPEN_ENDPOINTS } from '../packages/app/throttle.js';

const clock = (start = 0) => { const state = { at: start }; return { now: () => state.at, advance: ms => { state.at += ms; } }; };

test('the endpoints an anonymous caller can reach are the ones that are counted', () => {
  assert.deepEqual([...OPEN_ENDPOINTS.keys()].sort(), [
    'POST /api/agent/v1/device', 'POST /api/agent/v1/device/token', 'POST /api/agent/v1/pair', 'POST /api/login',
  ]);
});

test('an authenticated route is not counted: it already knows who is calling', () => {
  const throttle = createThrottle();
  for (let i = 0; i < 5000; i += 1) assert.equal(throttle.check('POST', '/api/requests', '198.51.100.7'), 0);
  assert.equal(throttle.check('GET', '/api/login', '198.51.100.7'), 0, '读取不做写入的工作');
});

test('one caller cannot make the node fill its own storage', () => {
  const throttle = createThrottle();
  const attacker = '198.51.100.7';
  let allowed = 0;
  for (let i = 0; i < 1000; i += 1) if (throttle.check('POST', '/api/agent/v1/device', attacker) === 0) allowed += 1;
  assert.equal(allowed, 30, '一千次尝试里只有三十次真的分配了记录');
});

test('one caller cannot make the node hammer the identity provider', () => {
  const throttle = createThrottle();
  let reached = 0;
  for (let i = 0; i < 500; i += 1) if (throttle.check('POST', '/api/login', '198.51.100.7') === 0) reached += 1;
  assert.equal(reached, 30);
});

test('a refusal says how long to wait, and the wait is honoured', () => {
  const time = clock();
  const throttle = createThrottle({ now: time.now });
  for (let i = 0; i < 30; i += 1) throttle.check('POST', '/api/login', 'a');
  const wait = throttle.check('POST', '/api/login', 'a');
  assert.ok(wait > 0 && wait <= 600, `应当给出等待秒数，得到 ${wait}`);
  time.advance(wait * 1000);
  assert.equal(throttle.check('POST', '/api/login', 'a'), 0, '等够了就该放行');
});

test('one noisy caller does not lock anybody else out', () => {
  const throttle = createThrottle();
  for (let i = 0; i < 100; i += 1) throttle.check('POST', '/api/login', 'noisy');
  assert.equal(throttle.check('POST', '/api/login', 'someone-else'), 0);
});

test('a device authorisation can be polled for its whole lifetime', () => {
  const throttle = createThrottle();
  // Ten minutes at the three-second interval the manifest publishes.
  let refused = 0;
  for (let i = 0; i < 200; i += 1) if (throttle.check('POST', '/api/agent/v1/device/token', 'agent') !== 0) refused += 1;
  assert.equal(refused, 0, '正常的 agent 轮询不该被挡');
});

test('a node that cannot tell its callers apart limits nobody, rather than everybody together', () => {
  const throttle = createThrottle();
  for (let i = 0; i < 1000; i += 1) assert.equal(throttle.check('POST', '/api/login', null), 0);
});

test('the count is forgotten once the window has passed, so the table cannot grow for ever', () => {
  const time = clock();
  const throttle = createThrottle({ now: time.now });
  for (const caller of ['a', 'b', 'c']) throttle.check('POST', '/api/login', caller);
  assert.equal(throttle.purge(), 3);
  time.advance(10 * 60 * 1000 + 1);
  assert.equal(throttle.purge(), 0);
  assert.equal(throttle.check('POST', '/api/login', 'a'), 0);
});
