const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createController } = require('../public/task-alerts');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-api-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['--require', './tests/fixtures/llm-transport.cjs', 'server.js'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), REPORT_DATA_FILE: path.join(directory, 'events.json') }
  });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', data => { if (String(data).includes('Agent Server running')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(Error('Server exited: ' + code)));
  });
  const url = 'http://127.0.0.1:' + port;
  const messages = [];
  const socket = new WebSocket('ws://127.0.0.1:' + port);
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const post = async (route, body) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const interact = text => post('/api/interact', { text, llmConfig: { apiKey: 'test-valid', provider: 'deepseek' } });
  const report = async () => (await fetch(url + '/api/report/today')).json();
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(predicate(), 'Expected WebSocket event/state within 5 seconds');
  };
  const state = () => messages.filter(message => message.type === 'STATE_UPDATE').at(-1)?.data;
  await waitFor(() => Boolean(state()));
  return { post, interact, report, messages, state, waitFor, socket, url };
}

async function reconnect(t, f) {
  const messages = [];
  const socket = new WebSocket(f.url.replace('http:', 'ws:'));
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  t.after(() => socket.terminate());
  await once(socket, 'open');
  await f.waitFor(() => messages.some(message => message.type === 'TASK_ALERTS'));
  return { socket, messages, backlog: messages.find(message => message.type === 'TASK_ALERTS').data };
}

test('a page waiting for a task auto-plays its missed expiry after a real socket reconnect', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const spoken = [];
  const controller = createController({
    speak: async text => { spoken.push(text); return true; },
    acknowledge: id => f.post('/api/task_alerts/ack', { id })
  });
  const { task } = await f.post('/api/task', { name: '倒垃圾', seconds: 1, reminder: true });
  await f.waitFor(() => f.state().activeTask?.id === task.id);
  controller.observeTasks(f.state());
  const closed = once(f.socket, 'close');
  f.socket.close();
  await closed;
  const deadline = Date.now() + 5000;
  while ((await f.report()).counts.remindersDue === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.report()).counts.remindersDue, 1);
  const restored = await reconnect(t, f);
  controller.observeTasks(restored.messages.find(message => message.type === 'STATE_UPDATE').data);
  controller.restore(restored.backlog);
  await f.waitFor(() => spoken.length === 1 && controller.list().length === 0);
  assert.match(spoken[0], /该倒垃圾了/);
  assert.equal((await reconnect(t, f)).backlog.length, 0);
});

test('expiry while the page is closed is restored as a silent backlog and can be acknowledged', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const closed = once(f.socket, 'close');
  f.socket.close();
  await closed;
  const { task } = await f.post('/api/task', { name: '倒垃圾', seconds: 1, reminder: true });
  const deadline = Date.now() + 5000;
  while ((await f.report()).counts.remindersDue === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.report()).counts.remindersDue, 1);
  const restored = await reconnect(t, f);
  assert.equal(restored.backlog.length, 1);
  assert.equal(restored.backlog[0].id, task.id);
  assert.equal(restored.messages.some(message => message.type === 'TASK_DONE'), false);
  await f.post('/api/task_alerts/ack', { id: task.id });
  await f.waitFor(() => restored.messages.some(message => message.type === 'TASK_ALERT_ACK' && message.data.id === task.id));
  assert.equal((await reconnect(t, f)).backlog.length, 0);
});

test('receiving a live alert does not discard it before playback acknowledgement', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.post('/api/task', { name: '倒垃圾', seconds: 1, reminder: true });
  await f.waitFor(() => f.messages.some(message => message.type === 'TASK_DONE'));
  const live = f.messages.find(message => message.type === 'TASK_DONE').data;
  assert.equal((await reconnect(t, f)).backlog[0].id, live.id);
  await f.post('/api/task_alerts/ack', { id: live.id });
  assert.equal((await reconnect(t, f)).backlog.length, 0);
});

test('voice-style Chinese reminder is 300 seconds and emits reminder text at expiry', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const start = Date.now();
  const response = await f.interact('五分钟后提醒倒垃圾');
  assert.match(response.reply, /五分钟后提醒你倒垃圾/);
  await f.waitFor(() => Boolean(f.state().activeTask));
  const task = f.state().activeTask;
  assert.equal(task.name, '倒垃圾');
  assert.equal(task.seconds, 300);
  assert.equal(task.minutes, 5);
  assert.equal(task.totalSeconds, 300);
  assert.equal(task.reminder, true);
  assert.ok(task.dueAt >= start + 300000 && task.dueAt <= Date.now() + 300000);
  await f.post('/api/task_control', { action: 'advance', seconds: 300 });
  await f.waitFor(() => f.messages.some(message => message.type === 'TASK_DONE'));
  const done = f.messages.find(message => message.type === 'TASK_DONE').data;
  assert.equal(done.reminder, true);
  assert.match(done.text, /提醒时间到了，该倒垃圾了/);
  assert.doesNotMatch(done.text, /完成/);
  assert.equal((await f.report()).counts.tasksFinished, 0);
  assert.equal((await f.report()).counts.remindersDue, 1);
});

test('compound instruction switches both devices immediately and creates exactly one reminder', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.interact('打开风扇，打开空调，然后5分钟以后提醒我倒垃圾');
  await f.waitFor(() => f.state().devices.ac === '开启');
  assert.equal(f.state().devices.fan, '开启');
  assert.equal(f.state().activeTask.name, '倒垃圾');
  assert.equal(f.state().activeTask.totalSeconds, 300);
  assert.equal(f.state().activeTask.reminder, true);
  assert.equal(f.state().pendingTasks.length, 0);
  const report = await f.report();
  assert.equal(report.counts.deviceChanges, 2);
  assert.equal(report.events.filter(event => event.type === 'task_created').length, 1);
});

test('queued reminder expires independently of a paused chore and does not finish that chore', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.post('/api/task', { name: '洗衣服', seconds: 600 });
  await f.post('/api/task_control', { action: 'pause' });
  await f.interact('一秒后提醒我倒垃圾');
  await f.waitFor(() => f.messages.some(message => message.type === 'TASK_DONE'));
  await f.waitFor(() => f.state().pendingTasks.length === 0);
  const done = f.messages.find(message => message.type === 'TASK_DONE').data;
  assert.equal(done.name, '倒垃圾');
  assert.equal(done.reminder, true);
  assert.equal(f.state().activeTask.name, '洗衣服');
  assert.equal(f.state().activeTask.paused, true);
  assert.equal((await f.report()).counts.tasksFinished, 0);
});

test('absolute reminder deadline is the clock time, with no extra chore duration', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const target = new Date(Date.now() + 120000);
  target.setSeconds(0, 0);
  const scheduledTime = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
  const { task } = await f.post('/api/task', { name: '倒垃圾', reminder: true, minutes: 10, execute: 'scheduled', scheduledTime });
  assert.equal(task.dueAt, target.getTime());
  assert.ok(task.totalSeconds <= 120);
});

test('pause is idempotent and resume, extend and advance maintain the reminder deadline', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.interact('五分钟后提醒我倒垃圾');
  const paused = (await f.post('/api/task_control', { action: 'pause' })).task;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const pausedAgain = (await f.post('/api/task_control', { action: 'pause' })).task;
  assert.equal(pausedAgain.remaining, paused.remaining);
  const resumed = (await f.post('/api/task_control', { action: 'resume' })).task;
  assert.ok(resumed.dueAt > paused.dueAt);
  const extended = (await f.post('/api/task_control', { action: 'extend', seconds: 60 })).task;
  assert.equal(extended.dueAt, resumed.dueAt + 60000);
  const advanced = (await f.post('/api/task_control', { action: 'advance', seconds: 60 })).task;
  assert.equal(advanced.dueAt, resumed.dueAt);
});

test('reminding about devices never operates them, and invalid compound commands have no side effects', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.interact('五分钟后提醒我打开风扇和空调');
  await f.waitFor(() => Boolean(f.state().activeTask));
  assert.equal(f.state().devices.fan, '关闭');
  assert.equal(f.state().devices.ac, '关闭');
  assert.equal(f.state().activeTask.name, '打开风扇和空调');
  const result = await f.interact('打开不存在的风扇，然后五分钟后提醒我倒垃圾');
  assert.match(result.reply, /没有检测到/);
  const report = await f.report();
  assert.equal(report.counts.deviceChanges, 0);
  assert.equal(report.events.filter(event => event.type === 'task_created').length, 1);
});
