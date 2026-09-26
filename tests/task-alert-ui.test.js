const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '../public/task-alerts.js'), 'utf8');

test('page wiring auto-speaks live events, silently restores history, and posts acknowledgements', async () => {
  const spoken = [], requests = [], elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: element },
    window: { HomeAvatar: { canSpeak: true, speak: async (text, options) => { spoken.push({ text, options }); return true; } } },
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
