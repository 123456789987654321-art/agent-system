const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const parserSource = fs.readFileSync(path.join(__dirname, '../public/task-parser.js'), 'utf8');

test('browser and server share Chinese duration parsing', () => {
  const context = vm.createContext({});
  vm.runInContext(parserSource, context);
  const start = appSource.indexOf('function parseRelativeDelay(');
  const end = appSource.indexOf('// 实时到点自动播报', start);
  vm.runInContext(appSource.slice(start, end), context);
  assert.equal(context.parseRelativeDelay('五分钟后').seconds, 300);
});

test('recognized voice text reaches the server intact through one interaction request', async () => {
  for (const text of ['五分钟后提醒倒垃圾', '打开风扇，打开空调，然后5分钟以后提醒我倒垃圾']) {
    const requests = [], spoken = [];
    const input = { value: text };
    const context = vm.createContext({
      document: {
        getElementById: () => input,
        querySelector: selector => selector.includes('provider') ? { value: 'deepseek' } : selector.includes('level') ? { value: 'low' } : {}
      },
      requireAgentConfiguration: () => true, isWeatherQuestion: () => false,
      parseTaskControlCommand: () => null, getEffectiveApiKey: () => 'test-key',
      showGlobalVoiceStatus() {}, hideGlobalVoiceStatus() {}, isAgentOffline: () => false,
      console: { log() {} }, agentRequestController: null, AbortController,
      agentSpeak: reply => spoken.push(reply),
      fetch: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ reply: '已安排提醒' }) };
      }
    });
    const start = appSource.indexOf('async function sendVoiceCommand(');
    const end = appSource.indexOf('// 拨动开关', start);
    vm.runInContext(appSource.slice(start, end), context);
    await context.sendVoiceCommand();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/interact');
    assert.equal(requests[0].body.text, text);
    assert.deepEqual(spoken, ['已安排提醒']);
    assert.equal(input.value, '');
  }
});
