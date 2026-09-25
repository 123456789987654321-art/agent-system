const test = require('node:test');
const assert = require('node:assert/strict');
const { createAddressLookup } = require('../services/location-address');
const address = { country: '中国', state: '福建省', city: '福州市', county: '鼓楼区' };

test('validates coordinates without sending invalid upstream requests', async () => {
  let requests = 0;
  const lookup = createAddressLookup({ request: async () => { requests++; } });
  for (const [lat, lon] of [[null, null], [91, 1], [1, -181], [NaN, 1], ['26', '119']]) {
    await assert.rejects(lookup(lat, lon), { statusCode: 400 });
  }
  assert.equal(requests, 0);
});

test('caches the same coordinates and passes identifying headers and timeout', async () => {
  let requests = 0;
  const lookup = createAddressLookup({ now: () => 1000, request: async (url, config) => {
    requests++;
    assert.equal(url, 'https://nominatim.openstreetmap.org/reverse');
    assert.deepEqual([config.params.lat, config.params.lon], [26.0753, 119.3062]);
    assert.match(config.headers['User-Agent'], /HomeAgentWeather/);
    assert.equal(config.timeout, 7000);
    return { data: { address } };
  } });
  assert.deepEqual(await lookup(26.0753, 119.3062), address);
  assert.deepEqual(await lookup(26.0753, 119.3062), address);
  assert.equal(requests, 1);
});

test('coalesces concurrent lookups for the same coordinates', async () => {
  let finish, requests = 0;
  const lookup = createAddressLookup({ request: () => { requests++; return new Promise(resolve => { finish = resolve; }); } });
  const first = lookup(26, 119), second = lookup(26, 119);
  finish({ data: { address } });
  assert.deepEqual(await first, address);
  assert.deepEqual(await second, address);
  assert.equal(requests, 1);
});

test('limits upstream request rate but permits cache hits', async () => {
  let clock = 1000;
  const lookup = createAddressLookup({ now: () => clock, request: async () => ({ data: { address } }) });
  await lookup(26, 119);
  await assert.rejects(lookup(30, 120), { statusCode: 429 });
  assert.deepEqual(await lookup(26, 119), address);
  clock += 1000;
  assert.deepEqual(await lookup(30, 120), address);
});

test('expires cached addresses and refreshes them', async () => {
  let clock = 1000, requests = 0;
  const lookup = createAddressLookup({ now: () => clock, request: async () => { requests++; return { data: { address } }; } });
  await lookup(26, 119);
  clock += 24 * 60 * 60 * 1000;
  await lookup(26, 119);
  assert.equal(requests, 2);
});

test('does not cache upstream failures and allows a later retry', async () => {
  let clock = 1000, fail = true;
  const lookup = createAddressLookup({ now: () => clock, request: async () => {
    if (fail) throw new Error('timeout');
    return { data: { address } };
  } });
  await assert.rejects(lookup(26, 119), { statusCode: 502 });
  clock += 1000;
  fail = false;
  assert.deepEqual(await lookup(26, 119), address);
});

test('rejects malformed responses and cools down on upstream rate limits', async () => {
  const malformed = createAddressLookup({ request: async () => ({ data: {} }) });
  await assert.rejects(malformed(26, 119), { statusCode: 502 });
  let clock = 1000, requests = 0;
  const limited = createAddressLookup({ now: () => clock, request: async () => {
    requests++;
    throw Object.assign(new Error('rate limit'), { response: { status: 429 } });
  } });
  await assert.rejects(limited(26, 119), { statusCode: 502 });
  clock += 1000;
  await assert.rejects(limited(30, 120), { statusCode: 429 });
  assert.equal(requests, 1);
});
