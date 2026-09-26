const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '../public/task-alerts.js'), 'utf8');

function fixture() {
  const spoken = [], requests = [], elements = new Map();
  const windowListeners = new Map(), documentListeners = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element, addEventListener: (name, callback) => documentListeners.set(name, callback) },
    window: { addEventListener: (name, callback) => windowListeners.set(name, callback), HomeAvatar: { canSpeak: true, speak: async (text, options) => { spoken.push({ text, options }); return true; } } },
    isAgentOffline: () => false, requireAgentConfiguration: () => true,
    getAgentIdleTitle: () => '待命', showGlobalVoiceStatus() {}, hideGlobalVoiceStatus() {},
    renderUI() {}, flushDeviceDemoQueue() {}, console,
    agentSpeechVersion: 0, speechInProgress: false,
    AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({ success: true }) }; }
  });
  vm.runInContext(controllerSource, context);
  vm.runInContext(source.slice(source.indexOf('// 实时到点自动播报'), source.indexOf('// ==== 倒计时框控制')), context);
  vm.runInContext(source.slice(source.indexOf('async function agentSpeak('), source.indexOf('initApiKeyWatcher();')), context);
  vm.runInContext(source.slice(source.indexOf('function handleSocketMessage('), source.indexOf('function connectSocket(')), context);
  const send = (type, data) => context.handleSocketMessage({ data: JSON.stringify({ type, data }) });
  return { context, send, spoken, requests, element, windowListeners, documentListeners };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('page wiring auto-speaks live events, silently restores history, and posts acknowledgements', async () => {
  const { context, send, spoken, requests, element } = fixture();
  const old = { id: 'old', name: '收衣服', text: '该收衣服了。' };
  send('TASK_ALERTS', [old]);
  assert.equal(spoken.length, 0);
  assert.equal(element('taskAlertBar').hidden, false);
  assert.match(element('taskAlertText').innerText, /到期未处理/);
  send('TASK_DONE', { id: 'live', name: '倒垃圾', text: '该倒垃圾了。' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].text, '该倒垃圾了。');
  assert.equal(spoken[0].options.continueWhenHidden, true);
  assert.equal(requests[0].url, '/api/task_alerts/ack');
  assert.equal(requests[0].method, 'POST');
  assert.equal(JSON.parse(requests[0].body).id, 'live');
  await context.speakPendingAlert();
  assert.equal(spoken[1].text, old.text);
  assert.equal(element('taskAlertBar').hidden, true);
  send('TASK_ALERTS', [{ id: 'ignored', name: '浇花' }]);
  await context.dismissPendingAlert();
  assert.equal(spoken.length, 2);
  assert.equal(element('taskAlertBar').hidden, true);
});

test('socket state remembers watched tasks and reconnect catches up without replaying old alerts', async () => {
  const { send, spoken, requests, element } = fixture();
  send('STATE_UPDATE', { activeTask: { id: 'watched', name: '倒垃圾' }, pendingTasks: [] });
  send('STATE_UPDATE', { activeTask: null, pendingTasks: [] });
  send('TASK_ALERTS', [{ id: 'old', name: '旧提醒', text: '旧提醒' }, { id: 'watched', name: '倒垃圾', text: '该倒垃圾了' }]);
  assert.match(element('taskAlertText').innerText, /正在播报：倒垃圾/);
  await flush();
  assert.deepEqual(spoken.map(item => item.text), ['该倒垃圾了']);
  assert.equal(JSON.parse(requests[0].body).id, 'watched');
  assert.match(element('taskAlertText').innerText, /到期未处理：旧提醒/);
});

test('live event before avatar module loads waits for readiness instead of failing permanently', async () => {
  const { context, send, spoken, windowListeners } = fixture();
  const avatar = context.window.HomeAvatar;
  delete context.window.HomeAvatar;
  send('TASK_DONE', { id: 'early', name: '倒垃圾', text: '该倒垃圾了' });
  await flush();
  assert.equal(spoken.length, 0);
  context.window.HomeAvatar = avatar;
  windowListeners.get('agent-speech-ready')();
  await flush();
  assert.equal(spoken.length, 1);
});

test('blocked playback keeps the browser error and retries only on a real user click', async () => {
  const { context, send, spoken, requests, element, documentListeners } = fixture();
  const speak = context.window.HomeAvatar.speak;
  context.window.HomeAvatar.speak = async () => { throw Error('浏览器未允许自动播放（not-allowed）'); };
  send('TASK_DONE', { id: 'blocked', name: '倒垃圾', text: '该倒垃圾了' });
  await flush();
  assert.match(element('taskAlertText').innerText, /not-allowed/);
  assert.equal(requests.length, 0);
  context.window.HomeAvatar.speak = speak;
  documentListeners.get('click')({ isTrusted: false });
  await flush();
  assert.equal(spoken.length, 0);
  documentListeners.get('click')({ isTrusted: true, target: { closest: () => ({ id: 'taskAlertDismiss' }) } });
  await flush();
  assert.equal(spoken.length, 0, 'the ignore button must not retry the alert it dismisses');
  documentListeners.get('click')({ isTrusted: true });
  await flush();
  assert.equal(spoken.length, 1);
  assert.equal(requests.length, 1);
});

test('a due alert waits for an existing reply and plays after it finishes', async () => {
  const { context, send, spoken, requests } = fixture();
  const speak = context.window.HomeAvatar.speak;
  let finish;
  context.window.HomeAvatar.speak = () => new Promise(resolve => { finish = resolve; });
  const reply = context.agentSpeak('操作已完成');
  send('TASK_DONE', { id: 'waiting', name: '倒垃圾', text: '该倒垃圾了' });
  assert.equal(requests.length, 0);
  context.window.HomeAvatar.speak = speak;
  finish(true);
  await reply;
  await flush();
  assert.equal(spoken.length, 1);
  assert.equal(JSON.parse(requests[0].body).id, 'waiting');
});
