const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('report API tracks real device changes, finished timers, reminders and task controls', { timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-report-api-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), REPORT_DATA_FILE: path.join(directory, 'events.json') }
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (String(data).includes('Agent Server running')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Server exited: ' + code)));
  });
  const url = 'http://127.0.0.1:' + port;
  const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const report = async () => (await fetch(url + '/api/report/today?timeZone=Asia%2FShanghai')).json();
  assert.equal((await report()).events.length, 0);
  assert.equal((await fetch(url + '/api/report/today?timeZone=invalid')).status, 400);
  assert.equal((await post('/api/toggle_device', { device: 'light_living', state: 'invalid' })).status, 400);
  await post('/api/toggle_device', { device: 'light_living', state: '开启' });
  await post('/api/toggle_device', { device: 'light_living', state: '开启' });
  assert.equal((await report()).counts.deviceChanges, 1);
  await post('/api/task', { name: '洗碗', seconds: 60 });
  for (const action of ['pause', 'resume', 'extend', 'advance', 'cancel']) await post('/api/task_control', { action, seconds: 2 });
  assert.equal((await report()).counts.tasksFinished, 0);
  await post('/api/task', { name: '浇花', seconds: 1 });
  for (let i = 0; i < 35 && (await report()).counts.tasksFinished === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await report()).counts.tasksFinished, 1);
  await post('/api/task', { name: '喝水', seconds: 1, reminder: true });
  for (let i = 0; i < 35 && (await report()).counts.remindersDue === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const result = await report();
  assert.equal(result.counts.remindersDue, 1);
  assert.equal(result.counts.tasksFinished, 1);
  for (const type of ['task_paused', 'task_resumed', 'task_extended', 'task_advanced', 'task_cancelled']) assert.ok(result.events.some(event => event.type === type), type);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'events.json'), 'utf8')).events.length, result.events.length);
});
