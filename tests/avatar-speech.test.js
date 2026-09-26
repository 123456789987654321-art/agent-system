const test = require('node:test');
const assert = require('node:assert/strict');

async function fixture(options = {}) {
  const { AvatarSpeech } = await import('../public/avatar-speech.mjs');
  const spoken = [], states = [];
  let enabled = true, cancelled = 0;
  const synthesis = {
    speak: utterance => spoken.push(utterance),
    cancel: () => cancelled++,
    getVoices: () => [{ lang: 'en-US' }, { lang: 'zh-CN' }],
  };
  const controller = new AvatarSpeech({ synthesis, Utterance: class { constructor(text) { this.text = text; } },
    isEnabled: () => enabled, onSpeech: active => states.push(active), ...options });
  return { controller, spoken, states, disable: () => { enabled = false; }, cancelled: () => cancelled };
}

test('no API configuration cannot start speech', async () => {
  const f = await fixture(); f.disable();
  await assert.rejects(f.controller.speak('你好'), /API/);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.controller.canSpeak, false);
});
test('mouth starts only on audio start and stops on audio end', async () => {
  const f = await fixture(); const result = f.controller.speak('你好');
  assert.deepEqual(f.states, [false]);
  assert.equal(f.spoken[0].voice.lang, 'zh-CN');
  f.spoken[0].onstart(); assert.equal(f.states.at(-1), true);
  f.spoken[0].onend(); assert.equal(await result, true);
  assert.equal(f.states.at(-1), false);
});
test('replacement cancels prior speech and ignores late callbacks', async () => {
  const f = await fixture(); const old = f.controller.speak('旧回复');
  const next = f.controller.speak('新回复');
  assert.equal(await old, false);
  f.spoken[1].onstart();
  f.spoken[0].onend(); f.spoken[0].onerror({ error: 'interrupted' });
  assert.equal(f.states.at(-1), true);
  f.spoken[1].onend(); assert.equal(await next, true);
});
test('long text is preserved including Unicode and playback is sequential', async () => {
  const f = await fixture(); const text = '今天🙂'.repeat(90);
  const result = f.controller.speak(text);
  for (let i = 0; i < 3; i++) {
    assert.equal(f.spoken.length, i + 1);
    assert.ok(Array.from(f.spoken[i].text).length <= 100);
    f.spoken[i].onstart(); f.spoken[i].onend();
  }
  assert.equal(await result, true);
  assert.equal(f.spoken.map(u => u.text).join(''), text);
});
test('removing API access prevents the next queued chunk', async () => {
  const f = await fixture(); const result = f.controller.speak('好'.repeat(150));
  f.spoken[0].onstart(); f.disable(); f.spoken[0].onend();
  assert.equal(await result, false); assert.equal(f.spoken.length, 1);
  assert.equal(f.states.at(-1), false);
});
test('stop settles pending speech even without a browser callback', async () => {
  const f = await fixture(); const result = f.controller.speak('你好');
  f.controller.stop(); assert.equal(await result, false);
  f.spoken[0].onstart(); assert.equal(f.states.at(-1), false);
});
test('playback errors stop animation and propagate', async () => {
  const f = await fixture(); const result = f.controller.speak('你好');
  const rejected = assert.rejects(result, /not-allowed/);
  f.spoken[0].onstart(); f.spoken[0].onerror({ error: 'not-allowed' });
  await rejected; assert.equal(f.states.at(-1), false);
});
test('unsupported speech and browser timeouts are reported', async () => {
  const unsupported = await fixture({ synthesis: undefined });
  assert.equal(unsupported.controller.canSpeak, false);
  await assert.rejects(unsupported.controller.speak('你好'), /不支持/);
  const f = await fixture({ timeout: 10 });
  await assert.rejects(f.controller.speak('你好'), /超时/);
  assert.equal(f.states.at(-1), false); assert.ok(f.cancelled() >= 2);
});
