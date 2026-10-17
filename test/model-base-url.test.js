import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
const env = { BOT_QQ: '10000001', PRIVATE_USER_QQ: '10000002', GROUP_QQ: '10000003',
  ONEBOT_ACCESS_TOKEN: 'test', DEEPSEEK_API_KEY: 'DEFAULT_SECRET', PRICE_INPUT_CNY_PER_MILLION: '2',
  PRICE_OUTPUT_CNY_PER_MILLION: '8', PRICE_VERIFIED_DATE: '2026-10-03' };
const alt = { MODEL_PROFILES: 'alt', MODEL_ALT_NAME: 'other-model', MODEL_ALT_API_KEY: 'ALT_SECRET',
  MODEL_ALT_PRICE_INPUT_CNY_PER_MILLION: '20', MODEL_ALT_PRICE_OUTPUT_CNY_PER_MILLION: '80',
  MODEL_ALT_PRICE_VERIFIED_DATE: '2026-10-03' };
test('default profile accepts credential-free https endpoints', () => {
  assert.equal(loadConfig({ ...env, MODEL_BASE_URL: 'https://api.deepseek.com/v1' }).baseUrl,
    'https://api.deepseek.com/v1');
});
test('default profile accepts http on loopback hosts with any port and keeps /v1', () => {
  for (const url of ['http://127.0.0.1:8788/v1', 'http://localhost:8788/v1', 'http://[::1]:8788/v1']) {
    assert.equal(loadConfig({ ...env, MODEL_BASE_URL: url }).baseUrl, url);
  }
});
test('default profile rejects http on non-loopback hosts', () => {
  for (const url of ['http://example.com/v1', 'http://192.168.1.9:8788/v1', 'http://127.0.0.1.example.com/v1']) {
    assert.throws(() => loadConfig({ ...env, MODEL_BASE_URL: url }), /回环|HTTPS/);
  }
});
test('default profile still rejects credentials, query strings and fragments', () => {
  for (const url of ['http://127.0.0.1:8788/v1?a=1', 'http://127.0.0.1:8788/v1#x',
    'https://user:secret@127.0.0.1:8788/v1', 'http://user:secret@127.0.0.1:8788/v1']) {
    assert.throws(() => loadConfig({ ...env, MODEL_BASE_URL: url }), /回环|HTTPS/);
  }
});
test('extra profiles accept http on loopback hosts', () => {
  const config = loadConfig({ ...env, ...alt, MODEL_ALT_BASE_URL: 'http://127.0.0.1:8788/v1' });
  assert.deepEqual(config.modelProfiles.map(p => p.id), ['default','alt']);
  assert.equal(config.modelProfiles[1].baseUrl, 'http://127.0.0.1:8788/v1');
});
test('extra profiles reject http on non-loopback hosts and keep key secrecy', () => {
  for (const url of ['http://provider.example/v1', 'http://10.0.0.2/v1', 'http://localhost.example/v1']) {
    assert.throws(() => loadConfig({ ...env, ...alt, MODEL_ALT_BASE_URL: url }),
      error => /回环|HTTPS/.test(error.message) && !error.message.includes('ALT_SECRET'));
  }
});
