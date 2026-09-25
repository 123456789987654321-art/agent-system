const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDailyReportStore, dayKey } = require('../services/daily-report');

test('daily reports use the visitor timezone and exclude the previous day', () => {
  let clock = Date.parse('2026-09-24T15:59:00Z');
  const store = createDailyReportStore({ now: () => clock });
  store.record('device_changed', { name: '客厅灯', state: '开启' });
  clock = Date.parse('2026-09-24T16:01:00Z');
  store.record('task_finished', { name: '洗碗' });
  const china = store.today('Asia/Shanghai');
  assert.equal(china.date, '2026-09-25');
  assert.equal(china.events.length, 1);
  assert.equal(china.counts.deviceChanges, 0);
  assert.equal(store.today('UTC').events.length, 2);
  assert.throws(() => dayKey(clock, 'not-a-timezone'), RangeError);
});

test('reminders and cancellations never count as finished household tasks', () => {
  const store = createDailyReportStore();
  store.record('task_created', { name: '洗碗', reminder: false });
  store.record('task_created', { name: '吃药', reminder: true });
  store.record('reminder_due', { name: '吃药', reminder: true });
  store.record('task_cancelled', { name: '洗碗' });
  store.record('device_changed', { name: '客厅灯', state: '开启', apiKey: 'not-to-be-stored' });
  const report = store.today('UTC', { devices: { light: '开启' }, activeTask: { id: 'a', name: '浇花', remaining: 30 }, pendingTasks: [] });
  assert.deepEqual(report.counts, { tasksCreated: 1, tasksFinished: 0, remindersDue: 1, deviceChanges: 1 });
  assert.equal(report.devicesOn, 1);
  assert.equal(report.activeTask.name, '浇花');
  assert.equal(JSON.stringify(report).includes('not-to-be-stored'), false);
});

test('history survives store restart without duplicating records', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.json');
  const first = createDailyReportStore({ filePath });
  first.record('task_finished', { taskId: 'one', name: '浇花' });
  const second = createDailyReportStore({ filePath });
  assert.equal(second.today('UTC').counts.tasksFinished, 1);
  assert.equal(second.today('UTC').trackingStartedAt, first.today('UTC').trackingStartedAt);
});

test('unreadable history is preserved and surfaced instead of overwritten', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.json');
  fs.writeFileSync(filePath, 'broken archive');
  const store = createDailyReportStore({ filePath });
  store.record('task_started', { name: '浇花' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'broken archive');
  assert.ok(store.today('UTC').storageWarning);
  assert.equal(store.today('UTC').events.length, 1);
});

test('records older than retention are removed from the persisted archive', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'home-report-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'events.json');
  let clock = Date.parse('2026-08-01T10:00:00Z');
  const store = createDailyReportStore({ filePath, now: () => clock });
  store.record('task_finished', { name: 'old task' });
  clock = Date.parse('2026-09-25T10:00:00Z');
  store.record('task_finished', { name: 'today task' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).events.map(event => event.name), ['today task']);
});
