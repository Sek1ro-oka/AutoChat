import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../src/runtime.js';

test('runtime fans out to every participant in registration order', async () => {
  const order = [];
  const runtime = new Runtime();
  runtime.use('a', () => { order.push('a'); return 'a'; });
  runtime.use('b', () => { order.push('b'); return 'b'; });
  assert.deepEqual(await runtime.dispatch({}, () => {}, () => true), ['a', 'b']);
  assert.deepEqual(order, ['a', 'b']);
});

test('a throwing participant is isolated and the rest still run', async () => {
  const seen = [], events = [];
  const runtime = new Runtime({ log: event => events.push(event) });
  runtime.use('boom', () => { throw new Error('kaput'); });
  runtime.use('ok', () => { seen.push('ok'); return 'done'; });
  assert.deepEqual(await runtime.dispatch(), [false, 'done']);
  assert.deepEqual(seen, ['ok']);
  assert.deepEqual(events, ['participant_failed']);
  const [boom, ok] = runtime.stats();
  assert.equal(boom.failures, 1);
  assert.equal(boom.lastError, 'kaput');
  assert.equal(ok.failures, 0);
});

test('an async rejecting participant is isolated too', async () => {
  const runtime = new Runtime();
  runtime.use('reject', async () => { throw new Error('nope'); });
  runtime.use('ok', async () => 'done');
  assert.deepEqual(await runtime.dispatch(), [false, 'done']);
});

test('drain waits for in-flight participant work', async () => {
  const runtime = new Runtime();
  let finished = false;
  runtime.use('slow', async () => { await new Promise(resolve => setTimeout(resolve, 20)); finished = true; });
  runtime.dispatch();
  assert.equal(finished, false);
  await runtime.drain();
  assert.equal(finished, true);
});

test('use rejects a non-function handler', () => {
  const runtime = new Runtime();
  assert.throws(() => runtime.use('bad', null), TypeError);
});
