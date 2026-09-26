const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createAvatarGateway, signSessionRequest, GATEWAY } = require('../services/avatar-gateway');

async function fixture(t, fetchImpl) {
  const calls = [];
  let clock = 1700000000000;
  const gateway = createAvatarGateway({ scheduleCleanup: false, now: () => clock, fetchImpl: async (url, init) => {
    calls.push({ url, ...init, data: JSON.parse(init.body) });
    return fetchImpl ? fetchImpl(url, init) : new Response(JSON.stringify({ error_code: 0, data: init.method === 'POST' ? { resource_pack: { fixture: true }, session_id: 'official-session' } : {} }));
  } });
  const app = express(); app.use(express.json()); app.use('/api/avatar', gateway.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await gateway.close(); await new Promise(resolve => server.close(resolve)); });
  async function send(path, method = 'POST', data, headers = {}) {
    const response = await fetch(base + '/api/avatar' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function grant() { return (await send('/credentials', 'POST', { appId: 'app-fixture', appSecret: 'private-fixture-secret' }, { 'X-Agent-Key': 'model-fixture-key' })).body; }
  return { calls, send, grant, gateway, advance: ms => { clock += ms; } };
}

test('official gateway requires model configuration and rejects cross-origin credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/credentials', 'POST', { appId: 'a', appSecret: 'b' })).status, 401);
  assert.equal((await f.send('/credentials', 'POST', { appId: 'a', appSecret: 'b' }, { 'X-Agent-Key': 'configured', Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.send('/session')).status, 401);
  assert.equal(f.calls.length, 0);
});

test('official signing matches the pinned SDK canonical JSON for unicode and nested keys', () => {
  const input = { z: '你 好', a: { y: 2, x: ['😀', 'a b'] } };
  const actual = signSessionRequest('app', 'secret', 'POST', input, 1700000000);
  const canonical = '{"a":{"x":["\\ud83d\\ude00","ab"],"y":2},"z":"\\u4f60\\u597d"}';
  const expected = crypto.createHash('md5').update('/user/v1/ttsa/sessionpost' + canonical + 'secret1700000000').digest('hex');
  assert.equal(actual.headers['X-TOKEN'], expected);
  assert.equal(actual.data.z, '你 好', 'signing must not alter spoken spaces');
});

test('proxy signs with server-held secret and forwards only the supported SDK protocol flags', async t => {
  const f = await fixture(t), grant = await f.grant();
  assert.ok(grant.accessToken);
  assert.ok(!JSON.stringify(grant).includes('private-fixture-secret'));
  const headers = { 'X-Avatar-Access': grant.accessToken };
  const result = await f.send('/session', 'POST', { request_id: 'untrusted-request', gatewayServer: 'https://other.example', config: { raw_audio: true, background_img: 'https://other.example/tracker', framedata_proto_version: 99 } }, headers);
  assert.equal(result.body.data.session_id, 'official-session');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const request = f.calls[0];
  assert.equal(request.url, GATEWAY);
  assert.notEqual(request.data.request_id, 'untrusted-request');
  assert.deepEqual(request.data.config, { framedata_proto_version: 2, raw_audio: true, walk_version: 3 });
  assert.equal(request.headers['X-APP-ID'], 'app-fixture');
  assert.equal(request.headers['X-TOKEN'], signSessionRequest('app-fixture', 'private-fixture-secret', 'POST', request.data, 1700000000).headers['X-TOKEN']);
  assert.ok(!request.body.includes('private-fixture-secret'));
  await f.send('/session', 'DELETE', { session_id: 'someone-elses-session' }, headers);
  assert.equal(f.calls[1].data.session_id, 'official-session');
  assert.equal(f.calls[1].data.stop_reason, 'user');
});

test('revoking credentials releases the session and prevents reuse of the bearer token', async t => {
  const f = await fixture(t), grant = await f.grant(), headers = { 'X-Avatar-Access': grant.accessToken };
  await f.send('/session', 'POST', {}, headers);
  assert.equal((await f.send('/credentials', 'DELETE', undefined, headers)).status, 200);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal((await f.send('/session', 'POST', {}, headers)).status, 401);
});

test('abandoned browser credentials expire and release an active official room', async t => {
  const f = await fixture(t), grant = await f.grant(), headers = { 'X-Avatar-Access': grant.accessToken };
  await f.send('/session', 'POST', {}, headers);
  f.advance(4 * 60000);
  assert.equal((await f.send('/keepalive', 'POST', undefined, headers)).status, 200);
  f.advance(6 * 60000); await f.gateway.sweep();
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal((await f.send('/keepalive', 'POST', undefined, headers)).status, 401);
});

test('provider authentication errors are reported without reflecting secrets', async t => {
  const f = await fixture(t, async () => new Response(JSON.stringify({ error_code: 403, error_reason: 'private-fixture-secret' }), { status: 403 }));
  const grant = await f.grant();
  const result = await f.send('/session', 'POST', {}, { 'X-Avatar-Access': grant.accessToken });
  assert.equal(result.body.error_code, 403);
  assert.ok(!JSON.stringify(result.body).includes('private-fixture-secret'));
});


test('SDK reconnect uses a new owned request id and releases its previous room', async t => {
  const f = await fixture(t), grant = await f.grant(), headers = { 'X-Avatar-Access': grant.accessToken };
  await f.send('/session', 'POST', { request_id: 'sdk-first' }, headers);
  await f.send('/session', 'POST', { request_id: 'sdk-second' }, headers);
  assert.deepEqual(f.calls.map(x => x.method), ['POST', 'DELETE', 'POST']);
  assert.notEqual(f.calls[0].data.request_id, f.calls[2].data.request_id);
  assert.equal(f.calls[1].data.request_id, f.calls[0].data.request_id);
});

test('revocation during initialization waits for and releases the newly created room', async t => {
  let finish, started;
  const creating = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async (url, init) => {
    if (init.method === 'POST') { started(); await new Promise(resolve => { finish = resolve; }); }
    return new Response(JSON.stringify({ error_code: 0, data: init.method === 'POST' ? { session_id: 'late-session', resource_pack: {} } : {} }));
  });
  const grant = await f.grant(), headers = { 'X-Avatar-Access': grant.accessToken };
  const pending = f.send('/session', 'POST', { request_id: 'sdk-first' }, headers);
  await creating;
  const revoking = f.send('/credentials', 'DELETE', undefined, headers);
  finish();
  await Promise.all([pending, revoking]);
  assert.equal(f.calls.at(-1).method, 'DELETE');
  assert.equal(f.calls.at(-1).data.session_id, 'late-session');
  assert.equal((await f.send('/keepalive', 'POST', undefined, headers)).status, 401);
});


test('responsive SDK layout is forwarded without allowing arbitrary rendering resources', async t => {
  const f = await fixture(t), grant = await f.grant(), headers = { 'X-Avatar-Access': grant.accessToken };
  await f.send('/session', 'POST', { config: { layout: { container: { size: [320, 420] }, avatar: { scale: '96vh', offset_x: 9999 } }, background_img: 'https://other.example/asset' } }, headers);
  assert.deepEqual(f.calls[0].data.config.layout, { container: { size: [320, 420] }, avatar: { v_align: 'bottom', h_align: 'center', scale: '96vh', offset_x: 0, offset_y: 0 } });
  assert.equal(f.calls[0].data.config.background_img, undefined);
});
