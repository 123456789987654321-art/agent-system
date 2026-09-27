const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const block = source.slice(source.indexOf('const AGENT_ONLINE_CAPTION'), source.indexOf('function switchPage'));

function browser(saved = {}) {
  const storage = initial => {
    const items = new Map(Object.entries(initial));
    return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)), removeItem: key => items.delete(key) };
  };
  const element = value => ({ value, style: {}, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, querySelector() { return null; } });
  const fields = {
    apiKeyInput: element(saved.agentApiKey || ''),
    modelInput: element(saved.agentModel || ''),
    saveStatus: element(''), saveStatusText: element(''),
    userInput: element(''), avatarCaptionTitle: element('')
  };
  const provider = { value: saved.agentProvider || 'deepseek' }, level = { value: 'low' };
  const buttons = [{}], notices = [];
  const context = vm.createContext({
    document: {
      getElementById: id => fields[id] || null,
      querySelector: selector => selector.includes('provider') ? provider : selector.includes('level') ? level : null,
      querySelectorAll: () => buttons
    },
    localStorage: storage(saved), sessionStorage: storage({}),
    window: { dispatchEvent() {}, addEventListener() {} },
    Event: class {}, AbortController, setTimeout, clearTimeout,
    showGlobalVoiceStatus: (...args) => notices.push(args), hideGlobalVoiceStatus() {},
    fetch: async () => ({ ok: true, json: async () => ({ success: true, provider: provider.value }) })
  });
  vm.runInContext(block, context);
  vm.runInContext('stopAgentActivity = () => {};', context);
  context.initApiKeyWatcher();
  context.updateAgentConnectionState();
  return { context, fields, provider, buttons, notices };
}

test('stored or merely typed keys never enable the agent before remote validation', async () => {
  const b = browser({ agentApiKey: 'fake-key' });
  assert.equal(b.context.isAgentOffline(), true);
  assert.equal(b.buttons[0].disabled, true);
  b.context.fetch = async () => ({ ok: false, json: async () => ({ error: 'API Key 已过期' }) });
  assert.equal(await b.context.verifyAgentConfiguration(b.context.getDraftAgentConfig()), false);
  assert.equal(b.context.isAgentOffline(), true);
  assert.match(b.fields.saveStatusText.innerText, /已过期/);
  b.fields.apiKeyInput.value = 'other-key';
  b.fields.apiKeyInput.listeners.input();
  assert.equal(b.context.isAgentOffline(), true);
});

test('only successful validation saves credentials and enables the exact key/provider/model', async () => {
  for (const mode of ['permanent', 'session']) {
    const b = browser();
    b.fields.apiKeyInput.value = 'valid-key';
    assert.equal(await b.context.saveConfig(mode), true);
    const store = mode === 'permanent' ? b.context.localStorage : b.context.sessionStorage;
    const other = mode === 'permanent' ? b.context.sessionStorage : b.context.localStorage;
    assert.equal(store.getItem('agentApiKey'), 'valid-key');
    assert.equal(other.getItem('agentApiKey'), null);
    assert.equal(b.context.isAgentOffline(), false);
    assert.equal(b.buttons[0].disabled, false);
    b.provider.value = 'qwen';
    b.context.updatePlaceholder();
    assert.equal(b.context.isAgentOffline(), true);
    assert.equal(b.buttons[0].disabled, true);
    b.provider.value = 'deepseek';
    assert.equal(b.context.isAgentOffline(), true, 'switching back must not restore stale verification');
    await b.context.saveConfig(mode);
    b.fields.modelInput.value = 'another-model';
    b.fields.modelInput.listeners.input();
    assert.equal(b.context.isAgentOffline(), true);
    assert.equal(b.fields.saveStatus.style.display, 'none');
  }
});

test('failed saves do not store fake keys and rejected interactions disable the agent', async () => {
  const b = browser();
  b.fields.apiKeyInput.value = 'invalid';
  b.context.fetch = async () => ({ ok: false, json: async () => ({ error: '平台不匹配' }) });
  assert.equal(await b.context.saveConfig('permanent'), false);
  assert.equal(b.context.localStorage.getItem('agentApiKey'), null);
  assert.equal(b.context.isAgentOffline(), true);
  b.context.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  await b.context.saveConfig('session');
  assert.equal(b.context.isAgentOffline(), false);
  b.context.showAgentRequestFailure('密钥已失效');
  assert.equal(b.context.isAgentOffline(), true);
  assert.equal(b.buttons[0].disabled, true);
  assert.match(b.notices.at(-1)[1], /密钥已失效/);
});

test('editing credentials or saving again discards stale validation responses', async () => {
  const b = browser();
  let release;
  b.fields.apiKeyInput.value = 'first-key';
  b.context.fetch = () => new Promise(resolve => { release = resolve; });
  const first = b.context.saveConfig('permanent');
  b.fields.apiKeyInput.value = 'second-key';
  b.fields.apiKeyInput.listeners.input();
  b.context.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  assert.equal(await b.context.saveConfig('session'), true);
  release({ ok: true, json: async () => ({ success: true }) });
  assert.equal(await first, false);
  assert.equal(b.context.sessionStorage.getItem('agentApiKey'), 'second-key');
  assert.equal(b.context.localStorage.getItem('agentApiKey'), null);
  assert.equal(b.context.isAgentOffline(), false);
});

test('refresh requires revalidation, clearing a key disables and removes saved credentials', async () => {
  const b = browser({ agentApiKey: 'valid-key', agentProvider: 'deepseek' });
  assert.equal(b.context.isAgentOffline(), true);
  assert.equal(await b.context.verifyAgentConfiguration(b.context.getDraftAgentConfig()), true);
  assert.equal(b.context.isAgentOffline(), false);
  b.fields.apiKeyInput.value = '';
  assert.equal(await b.context.saveConfig('permanent'), false);
  assert.equal(b.context.localStorage.getItem('agentApiKey'), null);
  assert.equal(b.context.sessionStorage.getItem('agentApiKey'), null);
  assert.equal(b.context.isAgentOffline(), true);
});

test('HTTP 200 without a validation success and network errors never enable the agent', async () => {
  for (const fetch of [async () => ({ ok: true, json: async () => ({}) }), async () => { throw new Error('network failed'); }]) {
    const b = browser();
    b.fields.apiKeyInput.value = 'key';
    b.context.fetch = fetch;
    assert.equal(await b.context.saveConfig('permanent'), false);
    assert.equal(b.context.isAgentOffline(), true);
    assert.equal(b.context.localStorage.getItem('agentApiKey'), null);
  }
});
