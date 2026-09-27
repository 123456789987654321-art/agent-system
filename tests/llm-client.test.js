const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { normalizeConfig, requestPlan, validateConfig } = require('../services/llm-client');

test('only fixed provider destinations are used with the exact chosen key and model', async t => {
  const calls = [];
  t.mock.method(axios, 'post', async (...args) => {
    calls.push(args);
    return { data: { choices: [{ message: { content: '{"reply":"ok","actions":[]}' } }] } };
  });
  for (const [provider, model, url] of [
    ['deepseek', 'deepseek-chat', 'https://api.deepseek.com/chat/completions'],
    ['qwen', 'qwen-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
    ['doubao', 'ep-my-endpoint', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions']
  ]) {
    const result = await validateConfig({ apiKey: '  test-key  ', provider, model });
    assert.deepEqual(result, { provider, model });
    const [destination, body, options] = calls.at(-1);
    assert.equal(destination, url);
    assert.equal(body.model, model);
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.timeout, 30000);
    assert.equal(options.maxRedirects, 0);
  }
  await requestPlan({ apiKey: 'x', provider: 'deepseek', level: 'high', model: 'custom-model' }, 'instruction');
  assert.equal(calls.at(-1)[1].temperature, 1);
  assert.equal(calls.at(-1)[1].model, 'custom-model');
  assert.equal(calls.length, 4);
});

test('invalid configuration is rejected before contacting a provider', async t => {
  const transport = t.mock.method(axios, 'post', () => { throw Error('must not request'); });
  for (const config of [null, {}, { apiKey: 'x' }, { apiKey: 'x', provider: 'constructor' },
    { apiKey: 'x\nbad', provider: 'deepseek' }, { apiKey: 'x', provider: 'qwen', model: 42 }]) {
    assert.throws(() => normalizeConfig(config));
    await assert.rejects(validateConfig(config));
  }
  assert.equal(transport.mock.callCount(), 0);
});

test('all three providers work with a key and provider only, using server defaults', async t => {
  const calls = [];
  t.mock.method(axios, 'post', async (...args) => {
    calls.push(args);
    return { data: { choices: [{ message: { content: '{"reply":"ok","actions":[]}' } }] } };
  });
  for (const [provider, expectedModel] of [
    ['deepseek', 'deepseek-chat'],
    ['qwen', 'qwen-plus'],
    ['doubao', process.env.DOUBAO_MODEL?.trim() || 'doubao-pro-32k']
  ]) {
    const result = await validateConfig({ apiKey: 'test-key', provider, level: 'low' });
    assert.equal(result.model, expectedModel);
    assert.equal(calls.at(-1)[1].model, expectedModel);
  }
  const original = process.env.DOUBAO_MODEL;
  try {
    process.env.DOUBAO_MODEL = 'ep-deployment-model';
    assert.equal(normalizeConfig({ apiKey: 'test-key', provider: 'doubao' }).model, 'ep-deployment-model');
  } finally {
    if (original === undefined) delete process.env.DOUBAO_MODEL;
    else process.env.DOUBAO_MODEL = original;
  }
});
