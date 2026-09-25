const test = require('node:test');
const assert = require('node:assert/strict');
const { createChinaCountyLookup, classifyGeometry, containingFeature } = require('../services/china-county');
const { createAddressLookup } = require('../services/location-address');
const square = (x, y, size) => [[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]];
const feature = (name, adcode, level, x = 100, y = 20, size = 4) => ({
  type: 'Feature', properties: { name, adcode, level },
  geometry: { type: 'Polygon', coordinates: [square(x, y, size)] }
});

test('supports polygons, holes, islands and boundary ambiguity', () => {
  const polygon = { type: 'Polygon', coordinates: [square(0,0,10), square(3,3,2)] };
  assert.equal(classifyGeometry([2,2], polygon), 1);
  assert.equal(classifyGeometry([4,4], polygon), 0);
  assert.equal(classifyGeometry([0,2], polygon), 2);
  assert.equal(classifyGeometry([3,4], polygon), 2);
  assert.equal(classifyGeometry([12,2], polygon), 0);
  const islands = { type: 'MultiPolygon', coordinates: [[square(0,0,2)], [square(5,5,2)]] };
  assert.equal(classifyGeometry([6,6], islands), 1);
  assert.equal(classifyGeometry([4,4], islands), 0);
});

test('never picks an arbitrary district from overlapping polygons', () => {
  assert.equal(containingFeature([101,21], [feature('甲县', 110101, 'district'), feature('乙县', 110102, 'district')]), null);
});

test('walks province, city and county boundaries and caches repeated region loads', async () => {
  let requests = 0, conversions = 0;
  const fixture = {
    100000: [feature('示例省', 110000, 'province')],
    110000: [feature('示例市', 110100, 'city')],
    110100: [feature('示例县', 110101, 'district')]
  };
  const lookup = createChinaCountyLookup({ project: (lon, lat) => { conversions++; return [lon, lat]; },
    request: async url => { requests++; const code = url.match(/(\d+)_full/)[1]; return { data: { features: fixture[code] } }; }
  });
  const result = await lookup(21,101);
  assert.equal(result.state, '示例省');
  assert.equal(result.city, '示例市');
  assert.equal(result.county, '示例县');
  assert.equal(result.county_source, 'datav-boundary');
  assert.equal((await lookup(22,102)).county, '示例县');
  assert.equal(requests, 3);
  assert.equal(conversions, 2);
});

test('supports municipality districts without requiring an extra city boundary file', async () => {
  const lookup = createChinaCountyLookup({ project: (lon,lat) => [lon,lat], request: async url => ({ data: {
    features: url.includes('100000_full') ? [feature('北京市',110000,'province')] : [feature('示例区',110101,'district')]
  } }) });
  const result = await lookup(21,101);
  assert.equal(result.city, '北京市');
  assert.equal(result.county, '示例区');
});

test('does not manufacture a county for uncovered or invalid coordinates', async () => {
  let requests = 0;
  const lookup = createChinaCountyLookup({ project: (lon,lat) => [lon,lat], request: async () => {
    requests++; return { data: { features: [feature('示例省',110000,'province')] } };
  } });
  assert.equal(await lookup(30,110), null);
  assert.equal(await lookup(90,180), null);
  assert.equal(await lookup(null,null), null);
  assert.equal(requests, 1);
});

test('fills the county when the primary source only returns a village and city', async () => {
  const partial = { country:'中国', country_code:'cn', state:'示例省', city:'示例市', village:'示例村' };
  const lookup = createAddressLookup({ request: async () => ({ data: { address: partial } }),
    countyLookup: async () => ({ state:'示例省', city:'示例市', county:'示例县', county_source:'datav-boundary' })
  });
  const result = await lookup(21,101);
  assert.equal(result.county, '示例县');
  assert.equal(result.village, '示例村');
});

test('keeps known address data and retries soon after a boundary lookup failure', async () => {
  let clock = 1000, fail = true, lookups = 0;
  const partial = { country:'中国', state:'示例省', city:'示例市', village:'示例村' };
  const lookup = createAddressLookup({ now: () => clock, request: async () => ({ data: { address: partial } }),
    countyLookup: async () => { lookups++; if (fail) throw Error('timeout'); return { county:'示例县' }; }
  });
  assert.equal((await lookup(21,101)).county, undefined);
  clock += 1000;
  await lookup(21,101);
  assert.equal(lookups, 1);
  clock += 60000;
  fail = false;
  assert.equal((await lookup(21,101)).county, '示例县');
  assert.equal(lookups, 2);
});

test('does not replace an existing county or query China boundaries for foreign addresses', async () => {
  for (const address of [{ country:'中国', county:'已知县' }, { country:'France', city:'Paris' }]) {
    let countyCalls = 0;
    const lookup = createAddressLookup({ request: async () => ({ data: { address } }),
      countyLookup: async () => { countyCalls++; return { county:'不应覆盖' }; }
    });
    assert.deepEqual(await lookup(21,101), address);
    assert.equal(countyCalls, 0);
  }
});
