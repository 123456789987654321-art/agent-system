const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('function formatLocationAddress(');
const end = source.indexOf('async function reverseGeocode(', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const format = context.formatLocationAddress;
const base = { country: '中国', state: '福建省', city: '福州市' };

// Synthetic response variants; these fixtures do not assert the user's actual location.
test('displays only country, province and city when a county is present', () => {
  assert.equal(format({ ...base, county: '连江县', town: '凤城镇' }), '中国-福建省-福州市');
});

test('omits county names returned under town', () => {
  assert.equal(format({ ...base, town: '连江县' }), '中国-福建省-福州市');
});

test('keeps the parent city instead of appending a county-level city', () => {
  assert.equal(format({ ...base, town: '福清市' }), '中国-福建省-福州市');
});

test('does not append towns, streets or communities', () => {
  for (const town of ['凤城镇', '某乡', '某街道', '某社区', '某小区', '某园区', '某开发区']) {
    assert.equal(format({ ...base, town }), '中国-福建省-福州市');
  }
});

test('does not append duplicate city data as a fourth level', () => {
  assert.equal(format({ ...base, county: '福州市', town: '福州市' }), '中国-福建省-福州市');
});

test('keeps the same three address levels for an IP fallback', () => {
  assert.equal(format({ ...base, town: '连江县' }, true), '中国-福建省-福州市');
});

test('does not add an unknown county placeholder when county data is absent', () => {
  assert.equal(format(base), '中国-福建省-福州市');
});

test('handles whitespace, missing values and municipalities', () => {
  assert.equal(format({ ...base, town: ' 连江县 ' }), '中国-福建省-福州市');
  assert.equal(format({ ...base, town: null }), '中国-福建省-福州市');
  assert.equal(format({ country: '中国', state: '北京市', city_district: '海淀区' }), '中国-北京市-北京市');
});
