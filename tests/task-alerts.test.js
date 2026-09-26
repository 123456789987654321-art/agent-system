const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../public/task-alerts');
const { createTaskAlertStore } = require('../services/task-alerts');

const alert = id => ({ id, name: '倒垃圾' + id, text: '提醒时间到了，该倒垃圾了。', reminder: true });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('live alerts auto-play once and acknowledge only after speech completes', async () => {
  let finish;
  const spoken = [], acknowledged = [];
  const controller = createController({
    speak: text => { spoken.push(text); return new Promise(resolve => { finish = resolve; }); },
    acknowledge: async id => acknowledged.push(id)
  });
  controller.receive(alert('one'));
  controller.receive(alert('one'));
  assert.equal(spoken.length, 1);
  assert.equal(acknowledged.length, 0);
  assert.equal(controller.list()[0].speaking, true);
  finish(true);
  await flush();
  assert.deepEqual(acknowledged, ['one']);
  assert.equal(controller.list().length, 0);
  controller.restore([alert('one')]);
  assert.equal(controller.list().length, 0);
});

test('missed alerts remain silent until the user chooses speak or ignore', async () => {
  const spoken = [], acknowledged = [];
  const controller = createController({ speak: async text => { spoken.push(text); return true; }, acknowledge: async id => acknowledged.push(id) });
  controller.restore([alert('one'), alert('two')]);
  await flush();
  assert.equal(spoken.length, 0);
  assert.equal(controller.list()[0].replayed, true);
  await controller.speakNext();
  assert.equal(spoken.length, 1);
  assert.deepEqual(acknowledged, ['one']);
  await controller.dismissNext();
  assert.equal(spoken.length, 1);
  assert.deepEqual(acknowledged, ['one', 'two']);
  assert.equal(controller.list().length, 0);
});

test('multiple live alerts play sequentially without auto-playing the restored backlog', async () => {
  const finishes = [], spoken = [];
  const controller = createController({ speak: text => { spoken.push(text); return new Promise(resolve => finishes.push(resolve)); }, acknowledge: async () => {} });
  controller.restore([alert('old')]);
  controller.receive(alert('one'));
  controller.receive(alert('two'));
  assert.equal(spoken.length, 1);
  finishes.shift()(true);
  await flush();
  assert.equal(spoken.length, 2);
  finishes.shift()(true);
  await flush();
  assert.deepEqual(controller.list().map(item => item.id), ['old']);
});

test('blocked, cancelled or failed speech stays unread for manual retry', async () => {
  for (const result of [false, new Error('autoplay blocked')]) {
    const acknowledged = [];
    let retry = false;
    const controller = createController({
      speak: async () => { if (retry) return true; if (result instanceof Error) throw result; return result; },
      acknowledge: async id => acknowledged.push(id)
    });
    controller.receive(alert('one'));
    await flush();
    assert.equal(acknowledged.length, 0);
    assert.equal(controller.list().length, 1);
    assert.match(controller.list()[0].error, /未完成播报/);
    retry = true;
    await controller.speakNext();
    assert.deepEqual(acknowledged, ['one']);
  }
});

test('acknowledgement failure retains the alert and acknowledgements from other pages remove it', async () => {
  const controller = createController({ speak: async () => true, acknowledge: async () => { throw Error('offline'); } });
  controller.receive(alert('one'));
  await flush();
  assert.equal(controller.list().length, 1);
  assert.match(controller.list()[0].error, /未同步/);
  controller.remove('one');
  controller.restore([alert('one')]);
  assert.equal(controller.list().length, 0);
});

test('unread alerts survive store restart and acknowledged alerts stay removed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-alerts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'alerts.json');
  const first = createTaskAlertStore({ filePath });
  first.add(alert('one'), alert('one').text);
  const restarted = createTaskAlertStore({ filePath });
  assert.equal(restarted.list()[0].id, 'one');
  restarted.acknowledge('one');
  restarted.acknowledge('one');
  assert.equal(createTaskAlertStore({ filePath }).list().length, 0);
});
