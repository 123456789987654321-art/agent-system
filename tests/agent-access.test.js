const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('model authentication gates saving and every instruction before side effects', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-access-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--require', './tests/fixtures/llm-transport.cjs', 'server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), REPORT_DATA_FILE: path.join(directory, 'events.json'), TASK_ALERT_DATA_FILE: path.join(directory, 'alerts.json') }
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (String(data).includes('Agent Server running')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Server exited: ' + code)));
  });
  const url = 'http://127.0.0.1:' + port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const config = (apiKey, extra = {}) => ({ apiKey, provider: 'deepseek', ...extra });
  const cases = [
    [undefined, 401, 'API_KEY_REQUIRED'],
    [{}, 401, 'API_KEY_REQUIRED'],
    [config(''), 401, 'API_KEY_REQUIRED'],
    [config('   '), 401, 'API_KEY_REQUIRED'],
    [config(123), 401, 'API_KEY_REQUIRED'],
    [config('bad key'), 400, 'API_KEY_INVALID_FORMAT'],
    [config('随便输入'), 400, 'API_KEY_INVALID_FORMAT'],
    [config('anything'), 401, 'API_KEY_REJECTED'],
    [config('test-expired'), 401, 'API_KEY_REJECTED'],
    [config('test-valid', { provider: 'qwen' }), 401, 'API_KEY_REJECTED'],
    [config('test-valid', { provider: 'other' }), 400, 'PROVIDER_INVALID'],
    [config('test-valid', { provider: '__proto__' }), 400, 'PROVIDER_INVALID'],
    [config('test-valid', { provider: 'doubao' }), 400, 'MODEL_REQUIRED'],
    [config('test-valid', { model: 'wrong-model' }), 400, 'MODEL_NOT_FOUND'],
    [config('test-denied'), 403, 'MODEL_ACCESS_DENIED'],
    [config('test-balance'), 402, 'API_BALANCE_INSUFFICIENT'],
    [config('test-rate'), 429, 'API_RATE_LIMITED'],
    [config('test-bad-request'), 400, 'MODEL_REQUEST_REJECTED'],
    [config('test-timeout'), 504, 'MODEL_TIMEOUT'],
    [config('test-network'), 502, 'MODEL_UNAVAILABLE'],
    [config('test-unavailable'), 502, 'MODEL_UNAVAILABLE'],
    [config('test-malformed'), 502, 'MODEL_RESPONSE_INVALID'],
    [config('test-empty'), 502, 'MODEL_RESPONSE_INVALID'],
    [config('test-actions'), 502, 'MODEL_RESPONSE_INVALID'],
    [config('test-error-envelope'), 502, 'MODEL_RESPONSE_INVALID']
  ];
  for (const [llmConfig, status, code] of cases) {
    for (const [route, text] of [
      ['/api/validate_config', undefined],
      ['/api/interact', '打开客厅灯'],
      ['/api/interact', '五分钟后提醒我倒垃圾'],
      ['/api/interact', '打开风扇，然后五分钟后提醒我倒垃圾'],
      ['/api/interact', '你好']
    ]) {
      const response = await post(route, { llmConfig, text });
      const body = await response.json();
      assert.equal(response.status, status, route + ' / ' + code);
      assert.equal(body.code, code);
      assert.equal(body.reply, undefined);
      assert.equal(body.success, undefined);
      assert.doesNotMatch(JSON.stringify(body), /Upstream secret|test-expired|Bearer/);
    }
  }
  const report = async () => (await (await fetch(url + '/api/report/today')).json());
  let state = await report();
  assert.equal(state.counts.deviceChanges, 0);
  assert.equal(state.events.filter(event => event.type === 'task_created').length, 0);

  // An earlier successful validation cannot authorize a now-revoked key.
  assert.equal((await post('/api/validate_config', { llmConfig: config('test-revoked') })).status, 200);
  assert.equal((await post('/api/interact', { text: '打开客厅灯', llmConfig: config('test-revoked') })).status, 401);
  assert.equal((await report()).counts.deviceChanges, 0);

  const validation = await post('/api/validate_config', { llmConfig: config('test-valid') });
  assert.equal(validation.status, 200);
  assert.equal(validation.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await validation.json(), { success: true, provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal((await report()).counts.deviceChanges, 0);
  assert.equal((await post('/api/interact', { text: '打开客厅灯', llmConfig: config('test-valid') })).status, 200);
  assert.equal((await report()).counts.deviceChanges, 1);
  const reminder = await post('/api/interact', { text: '五分钟后提醒我倒垃圾', llmConfig: config('test-valid') });
  assert.match((await reminder.json()).reply, /提醒/);
  assert.equal((await report()).events.filter(event => event.type === 'task_created').length, 1);
  assert.equal((await post('/api/interact', { text: '你好', llmConfig: config('test-valid') })).status, 200);

  // Existing manual controls intentionally remain independent of model access.
  assert.equal((await post('/api/toggle_device', { device: 'light_living', state: '关闭' })).status, 200);
  assert.equal((await post('/api/task', { name: '手动测试任务', seconds: 60 })).status, 200);
  assert.equal((await post('/api/task_control', { action: 'pause' })).status, 200);
});
