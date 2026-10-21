import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalDev, keyTestEnabled, proxyHops, trustCfHeader, makeClientIp } from '../src/lib/runtime.js';
import { createLimiter } from '../src/lib/ratelimit.js';

test('key test endpoint: on for local development, off when hosted, ENABLE_KEY_TEST overrides either way', () => {
  assert.equal(keyTestEnabled({}), true);
  assert.equal(keyTestEnabled({ BASE_URL: 'http://127.0.0.1:7000' }), true);
  assert.equal(keyTestEnabled({ BASE_URL: 'https://subs.example.com' }), false);
  assert.equal(keyTestEnabled({ RENDER: 'true' }), false);
  assert.equal(keyTestEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(keyTestEnabled({ RENDER: 'true', ENABLE_KEY_TEST: '1' }), true);
  assert.equal(keyTestEnabled({ BASE_URL: 'https://subs.example.com', ENABLE_KEY_TEST: 'TRUE' }), true);
  assert.equal(keyTestEnabled({ ENABLE_KEY_TEST: '0' }), false);
  assert.equal(keyTestEnabled({ ENABLE_KEY_TEST: 'off' }), false);
  // anything that is not a clear on/off value falls back to the default
  assert.equal(keyTestEnabled({ ENABLE_KEY_TEST: 'maybe', RENDER: '1' }), false);
  assert.equal(keyTestEnabled({ ENABLE_KEY_TEST: '' }), true);
  assert.equal(isLocalDev({ BASE_URL: 'not a url' }), false);
});

test('proxy hops: TRUST_PROXY_HOPS wins, the old TRUST_PROXY means 1, Render means 1, otherwise 0', () => {
  assert.deepEqual(proxyHops({}), { hops: 0, warning: null });
  assert.equal(proxyHops({ RENDER: 'true' }).hops, 1);
  assert.equal(proxyHops({ TRUST_PROXY: '1' }).hops, 1);
  assert.equal(proxyHops({ TRUST_PROXY: 'yes' }).hops, 1);
  assert.equal(proxyHops({ TRUST_PROXY: '0' }).hops, 0);
  assert.equal(proxyHops({ TRUST_PROXY_HOPS: '2', RENDER: 'true' }).hops, 2);
  assert.equal(proxyHops({ TRUST_PROXY_HOPS: '0', RENDER: 'true' }).hops, 0); // explicit "none" beats the Render default
  assert.equal(proxyHops({ TRUST_PROXY_HOPS: ' 3 ' }).hops, 3);
});

test('proxy hops: an unusable TRUST_PROXY_HOPS is ignored with a warning and the default applies', () => {
  for (const bad of ['abc', '-1', '1.5', '11', '1e1']) {
    const r = proxyHops({ TRUST_PROXY_HOPS: bad, RENDER: 'true' });
    assert.equal(r.hops, 1, bad);
    assert.match(r.warning, /TRUST_PROXY_HOPS/, bad);
  }
  assert.equal(proxyHops({ TRUST_PROXY_HOPS: 'abc' }).hops, 0);
});

test('client IP: req.ip by default; CF-Connecting-IP only when explicitly enabled and valid', () => {
  const req = (cf, ip = '10.0.0.1') => ({ ip, headers: cf === undefined ? {} : { 'cf-connecting-ip': cf } });
  const off = makeClientIp({});
  assert.equal(off(req('203.0.113.9')), '10.0.0.1', 'header ignored unless enabled');
  assert.equal(makeClientIp({ TRUST_CF_CONNECTING_IP: '0' })(req('203.0.113.9')), '10.0.0.1');
  assert.equal(trustCfHeader({ TRUST_CF_CONNECTING_IP: '1' }), true);
  assert.equal(trustCfHeader({ TRUST_CF_CONNECTING_IP: 'x' }), false);
  const on = makeClientIp({ TRUST_CF_CONNECTING_IP: 'true' });
  assert.equal(on(req('203.0.113.9')), '203.0.113.9');
  assert.equal(on(req(' 2001:db8::1 ')), '2001:db8::1');
  for (const bad of ['', 'not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1', undefined]) assert.equal(on(req(bad)), '10.0.0.1', String(bad));
  assert.equal(on({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  assert.equal(on({}), 'unknown');
});

test('rate limiter takes its client from keyOf when given', () => {
  const l = createLimiter({ limit: 1, windowMs: 60000, keyOf: (r) => r.headers.who });
  const hit = (who) => {
    let nexted = false;
    const res = { set() {}, status() { return res; }, json() {} };
    l.middleware({ ip: '1.1.1.1', headers: { who } }, res, () => { nexted = true; });
    return nexted;
  };
  assert.equal(hit('a'), true);
  assert.equal(hit('b'), true); // same req.ip, different client
  assert.equal(hit('a'), false);
});
