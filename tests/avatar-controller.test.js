const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../public/avatar-controller.mjs');

async function fixture(t, { initialize, requestOverride, enabled = true, timeout = 1000 } = {}) {
  const { OfficialAvatarController } = await modulePromise;
  const calls = [], instances = [], states = [];
  let access = enabled;
  class SDK {
    constructor(options) { this.options = options; instances.push(this); }
    async init(callbacks) {
      this.callbacks = callbacks;
      if (initialize) return initialize(this);
      this.sessionId = 'real-session-fixture';
      callbacks.onDownloadProgress(100);
      this.options.onStatusChange(0);
    }
    getSessionId() { return this.sessionId; }
    destroy() { this.destroyed = true; }
    interrupt() { this.interrupted = true; }
    interactiveidle() {}
    speak(text, first, last, extra) { this.lastSpeech = { text, first, last, extra }; }
    changeLayout() {}
    listen() {}
  }
  const controller = new OfficialAvatarController({
    request: async (url, options) => {
      calls.push({ url, options });
      if (requestOverride) return requestOverride(url, options);
      return url.endsWith('/credentials') && options.method === 'POST' ? { accessToken: 'temporary-token', appId: 'official-app', sdkUrl: '/sdk.js', gateway: '/api/avatar/session' } : { ok: true };
    },
    loadSdk: async () => SDK, isEnabled: () => access, getAgentKey: () => 'model-key', getContainer: () => ({}), getLayout: () => ({}),
    onChange: value => states.push(value), timeout,
  });
  t.after(() => controller.disconnect());
  return { controller, calls, instances, states, disable: () => { access = false; } };
}
const credentials = { appId: 'official-app', appSecret: 'secret-only-for-server' };

test('no model key means no credential exchange or official SDK construction', async t => {
  const f = await fixture(t, { enabled: false });
  await assert.rejects(f.controller.connect(credentials));
  assert.equal(f.calls.length, 0); assert.equal(f.instances.length, 0);
});

test('only actual download and session callbacks make the avatar ready; SDK receives no real secret', async t => {
  const f = await fixture(t);
  assert.equal(await f.controller.connect(credentials), true);
  assert.equal(f.controller.ready, true);
  assert.equal(f.instances[0].options.appSecret, 'server-managed');
  assert.ok(!JSON.stringify(f.instances[0].options).includes(credentials.appSecret));
  assert.equal(f.instances[0].options.headers['X-Avatar-Access'], 'temporary-token');
  assert.equal(f.controller.diagnostics().sessionId, 'real-session-fixture');
});

test('a successful credential exchange cannot masquerade as a loaded official model', async t => {
  const f = await fixture(t, { initialize: async () => {}, timeout: 25 });
  await assert.rejects(f.controller.connect(credentials), /超时/);
  assert.equal(f.controller.ready, false);
  assert.ok(!f.states.some(x => x.state === 'ready'));
  assert.ok(f.instances[0].destroyed);
  assert.ok(f.calls.some(x => x.options.method === 'DELETE'));
});

test('speech waits for the matching official completion event and escapes SSML', async t => {
  const f = await fixture(t); await f.controller.connect(credentials);
  const result = f.controller.speak('测试 <uievent> & "内容"');
  const sdk = f.instances[0], id = sdk.lastSpeech.extra.client_speak_id;
  assert.equal(sdk.lastSpeech.text, '<speak>测试 &lt;uievent&gt; &amp; &quot;内容&quot;</speak>');
  sdk.options.onSpeakStateChange('speak_end', 'stale-id');
  assert.equal(f.controller.pending.id, id);
  sdk.options.onSpeakStateChange('speak_end', id);
  assert.equal(await result, true);
});

test('disconnect cancels speech, destroys the SDK and revokes the temporary credential', async t => {
  const f = await fixture(t); await f.controller.connect(credentials);
  const speaking = f.controller.speak('正在播报');
  f.disable(); await f.controller.disconnect('api_removed');
  assert.equal(await speaking, false);
  assert.equal(f.controller.ready, false);
  assert.ok(f.instances[0].destroyed);
  assert.ok(f.calls.some(x => x.url === '/api/avatar/credentials' && x.options.method === 'DELETE'));
  await assert.rejects(f.controller.speak('不应播报'));
});

test('clearing the model key while credential exchange is pending prevents late SDK creation', async t => {
  let complete, requested;
  const started = new Promise(resolve => { requested = resolve; });
  const f = await fixture(t, { requestOverride: (url, options) => {
    if (options.method === 'POST') { requested(); return new Promise(resolve => { complete = resolve; }); }
    return Promise.resolve({ ok: true });
  } });
  const connecting = f.controller.connect(credentials); await started;
  f.disable(); await f.controller.disconnect('api_removed');
  complete({ accessToken: 'late-token', appId: 'official-app', sdkUrl: '/sdk.js', gateway: '/api/avatar/session' });
  assert.equal(await connecting, false);
  assert.equal(f.instances.length, 0);
  assert.ok(f.calls.some(x => x.options.headers?.['X-Avatar-Access'] === 'late-token' && x.options.method === 'DELETE'));
});
