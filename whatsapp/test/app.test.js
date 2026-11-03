import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const apiKey = 'a'.repeat(32);
const organization = { apiKeyEnv: 'ORG_KEY', accessTokenEnv: 'ORG_TOKEN', phoneNumberId: '12345', templates: {
  renewal: { name: 'library_subscription_renewal', language: 'en', bodyParameters: ['name', 'date'] }
} };
const env = { WHATSAPP_MODE: 'messaging', META_GRAPH_VERSION: 'v99.0', META_APP_SECRET: 'test-secret', META_WEBHOOK_VERIFY_TOKEN: 'test-verify',
  ORGANIZATIONS_JSON: JSON.stringify({ library: organization, restaurant: { ...organization, apiKeyEnv: 'OTHER_KEY', phoneNumberId: '67890' } }),
  ORG_KEY: apiKey, OTHER_KEY: 'b'.repeat(32), ORG_TOKEN: 'secret-access-token' };
const message = { to: '919876543210', template: 'renewal', parameters: { name: 'Asha', date: '2026-12-01' }, recipientOptIn: true };

async function fixture(t, fetchImpl, configEnv = env) {
  const logs = [];
  const calls = [];
  const server = createServer(createApp(loadConfig(configEnv), {
    fetchImpl: async (...args) => {
      calls.push(args);
      return fetchImpl ? fetchImpl(...args) : new Response(JSON.stringify({ messages: [{ id: 'wamid.test' }] }), { status: 200 });
    }, log: event => logs.push(event)
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (data = message, org = 'library', key = apiKey) => fetch(`${base}/v1/organizations/${org}/messages/template`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return { base, send, logs, calls };
}

test('maps configured fields in order to the direct Meta API and returns accepted', async t => {
  const f = await fixture(t);
  const response = await f.send();
  assert.equal(response.status, 202);
  assert.equal((await response.json()).messageId, 'wamid.test');
  assert.equal(f.calls[0][0], 'https://graph.facebook.com/v99.0/12345/messages');
  const options = f.calls[0][1];
  assert.equal(options.headers.Authorization, 'Bearer secret-access-token');
  assert.deepEqual(JSON.parse(options.body).template, { name: 'library_subscription_renewal', language: { code: 'en' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: '2026-12-01' }] }] });
  assert.ok(!JSON.stringify(f.logs).includes(message.to));
  assert.ok(!JSON.stringify(f.logs).includes('secret-access-token'));
});
test('prevents cross-organization sending and hides unknown organizations', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(message, 'restaurant')).status, 401);
  assert.equal((await f.send(message, 'missing')).status, 401);
  assert.equal((await f.send(message, 'library', 'wrong')).status, 401);
  assert.equal(f.calls.length, 0);
});
test('rejects invalid phone, missing consent, template injection, extra and missing fields before Meta', async t => {
  const f = await fixture(t);
  for (const patch of [{ to: '+919876543210' }, { recipientOptIn: false }, { template: '__proto__' },
    { parameters: { name: 'Asha' } }, { parameters: { ...message.parameters, extra: 'x' } }, { phoneNumberId: '67890' }]) {
    assert.equal((await f.send({ ...message, ...patch })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});
test('uses the authenticated organization sender', async t => {
  const f = await fixture(t);
  assert.equal((await f.send(message, 'restaurant', env.OTHER_KEY)).status, 202);
  assert.match(f.calls[0][0], /\/67890\/messages$/);
});
test('Meta rejection is sanitized and never retried', async t => {
  const f = await fixture(t, () => new Response(JSON.stringify({ error: { message: 'sensitive upstream text' } }), { status: 429 }));
  const r = await f.send();
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error.code, 'META_REJECTED');
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes('sensitive'));
});
test('timeout/network failure and malformed success report unknown outcome without retry', async t => {
  for (const impl of [() => { throw new Error('timeout'); }, () => new Response('{}'), () => new Response('bad json')]) {
    const f = await fixture(t, impl);
    const r = await f.send();
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'META_OUTCOME_UNKNOWN');
    assert.equal(f.calls.length, 1);
  }
});
test('verifies the Meta subscription challenge', async t => {
  const f = await fixture(t);
  const path = '/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=1234&hub.verify_token=';
  const r = await fetch(f.base + path + 'test-verify');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '1234');
  assert.equal((await fetch(f.base + path + 'wrong')).status, 403);
});
test('verifies raw webhook bytes and records status without logging recipient data', async t => {
  const f = await fixture(t);
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '12345' }, statuses: [{ id: 'wamid.test', status: 'delivered', recipient_id: message.to }]
  } }] }] });
  const signature = 'sha256=' + createHmac('sha256', env.META_APP_SECRET).update(raw).digest('hex');
  const post = (value, sig) => fetch(f.base + '/webhooks/whatsapp', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: value });
  assert.equal((await post(raw, signature)).status, 200);
  assert.equal((await post(raw + ' ', signature)).status, 401);
  assert.equal((await post(raw, 'bad')).status, 401);
  assert.equal(f.logs.filter(e => e.event === 'whatsapp_status').length, 1);
  assert.ok(!JSON.stringify(f.logs).includes(message.to));
});
test('rejects malformed JSON, wrong content type, and oversized bodies', async t => {
  const f = await fixture(t);
  const post = (body, contentType) => fetch(f.base + '/v1/organizations/library/messages/template', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': contentType }, body
  });
  assert.equal((await post('{', 'application/json')).status, 400);
  assert.equal((await post('{}', 'text/plain')).status, 415);
  assert.equal((await post('x'.repeat(66000), 'application/json')).status, 413);
  assert.equal(f.calls.length, 0);
});
test('health is public and unknown routes return 404', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/healthz')).status, 200);
  assert.equal((await fetch(f.base + '/unknown')).status, 404);
});
test('startup rejects missing secrets, invalid version/sender and reused tenant keys', () => {
  assert.throws(() => loadConfig({ ...env, META_APP_SECRET: '' }), /Configure/);
  assert.throws(() => loadConfig({ ...env, META_GRAPH_VERSION: 'vXX.X' }), /META_GRAPH_VERSION/);
  assert.throws(() => loadConfig({ ...env, OTHER_KEY: apiKey }), /unique/);
  assert.throws(() => loadConfig({ ...env, ORGANIZATIONS_JSON: JSON.stringify({ library: { ...organization, phoneNumberId: 'placeholder' } }) }), /Invalid organization/);
});

test('default mode starts with only a verify token and ignores unfinished sender config', () => {
  const config = loadConfig({ META_WEBHOOK_VERIFY_TOKEN: 'test-verify', META_GRAPH_VERSION: 'vXX.X', ORGANIZATIONS_FILE: '/does-not-exist' });
  assert.equal(config.mode, 'webhook');
  assert.equal(config.organizations.size, 0);
  assert.equal(config.appSecret, undefined);
  assert.throws(() => loadConfig({}), /META_WEBHOOK_VERIFY_TOKEN/);
  assert.throws(() => loadConfig({ META_WEBHOOK_VERIFY_TOKEN: 'test-verify', WHATSAPP_MODE: 'typo' }), /WHATSAPP_MODE/);
});

test('token-only deployment verifies callback, stays healthy, blocks sending and unsigned receiving', async t => {
  const f = await fixture(t, undefined, { META_WEBHOOK_VERIFY_TOKEN: 'test-verify' });
  const path = '/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=callback-test&hub.verify_token=';
  const r = await fetch(f.base + path + 'test-verify');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'callback-test');
  assert.equal((await fetch(f.base + path + 'wrong')).status, 403);
  assert.equal((await fetch(f.base + '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify')).status, 403);
  assert.equal((await fetch(f.base + '/healthz')).status, 200);
  const send = await f.send();
  assert.equal(send.status, 503);
  assert.equal((await send.json()).error.code, 'MESSAGING_DISABLED');
  const post = await fetch(f.base + '/webhooks/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 503);
  assert.equal((await post.json()).error.code, 'WEBHOOK_RECEIVING_DISABLED');
  assert.equal(f.calls.length, 0);
});

test('webhook-only deployment receives signed events when app secret is configured', async t => {
  const f = await fixture(t, undefined, { META_WEBHOOK_VERIFY_TOKEN: 'test-verify', META_APP_SECRET: 'test-secret' });
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const post = signature => fetch(f.base + '/webhooks/whatsapp', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Hub-Signature-256': signature
  }, body: raw });
  const signature = 'sha256=' + createHmac('sha256', 'test-secret').update(raw).digest('hex');
  assert.equal((await post(signature)).status, 200);
  assert.equal((await post('invalid')).status, 401);
  assert.equal((await f.send()).status, 503);
  assert.equal(f.calls.length, 0);
});
