const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRelativeDelay, parseTaskCommand, splitCommandClauses } = require('../public/task-parser');

test('spoken Chinese and numeric durations have the same precise duration', () => {
  for (const [text, seconds] of [
    ['五分钟后', 300], ['5分钟以后', 300], ['十五分钟后', 900], ['两分钟后', 120],
    ['一百零五秒后', 105], ['半小时后', 1800], ['一个半小时后', 5400],
    ['一小时半后', 5400], ['1.5小时后', 5400], ['一小时三十分钟后', 5400],
    ['10s后', 10], ['5min后', 300], ['2hours后', 7200]
  ]) assert.equal(parseRelativeDelay(text).seconds, seconds, text);
});

test('reminders never fall back to a preset duration or completed-task type', () => {
  for (const text of ['五分钟后提醒倒垃圾', '五分钟后提醒我倒垃圾', '5分钟以后提醒我倒垃圾', '请五分钟后提醒我倒垃圾']) {
    const task = parseTaskCommand(text);
    assert.equal(task.name, '倒垃圾', text);
    assert.equal(task.seconds, 300, text);
    assert.equal(task.reminder, true, text);
    assert.equal(task.execute, 'now', text);
    assert.equal(task.scheduledTime, '', text);
  }
  for (const text of ['提醒我倒垃圾', '零分钟后提醒我倒垃圾', '0分钟后提醒我倒垃圾', '五分钟后提醒我']) {
    assert.ok(parseTaskCommand(text).error, text);
  }
});

test('compound commands keep the immediate device clauses separate from the reminder', () => {
  for (const text of [
    '打开风扇，打开空调，然后5分钟以后提醒我倒垃圾',
    '打开风扇然后打开空调然后五分钟后提醒我倒垃圾',
    '打开风扇，打开空调，五分钟后，提醒我倒垃圾'
  ]) {
    const clauses = splitCommandClauses(text);
    assert.equal(clauses.length, 3);
    assert.equal(parseTaskCommand(clauses[0]), null);
    assert.equal(parseTaskCommand(clauses[1]), null);
    const task = parseTaskCommand(clauses[2]);
    assert.equal(task.name, '倒垃圾');
    assert.equal(task.seconds, 300);
    assert.equal(task.reminder, true);
  }
});

test('a reminder to operate a device remains a reminder', () => {
  const task = parseTaskCommand('五分钟后提醒我打开风扇和空调');
  assert.equal(task.name, '打开风扇和空调');
  assert.equal(task.reminder, true);
  assert.equal(task.seconds, 300);
});

test('explicit timers retain the requested duration and ordinary chores retain defaults', () => {
  assert.equal(parseTaskCommand('洗衣服计时五分钟').seconds, 300);
  assert.equal(parseTaskCommand('洗衣服计时五分钟').reminder, false);
  assert.equal(parseTaskCommand('现在倒垃圾').minutes, 10);
  assert.equal(parseTaskCommand('明天17:30提醒我收衣服').dayOffset, 1);
  assert.equal(parseTaskCommand('17:30提醒我收衣服').reminder, true);
});
