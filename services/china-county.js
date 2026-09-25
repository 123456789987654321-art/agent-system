const axios = require('axios');
const { wgs84togcj02 } = require('coordtransform');

// 0: outside, 1: inside, 2: on the boundary. Do not guess when a point is on an edge.
function classifyRing(point, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-10 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj)
      && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return 2;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 1 : 0;
}

function classifyGeometry(point, geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
    : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  let result = 0;
  for (const polygon of polygons) {
    const outer = classifyRing(point, polygon[0]);
    if (outer === 2) return 2;
    if (!outer) continue;
    const holes = polygon.slice(1).map(ring => classifyRing(point, ring));
    if (holes.includes(2)) return 2;
    if (!holes.includes(1)) result = 1;
  }
  return result;
}

function containingFeature(point, features) {
  const matches = [];
  for (const feature of features) {
    const result = classifyGeometry(point, feature.geometry);
    if (result === 2) return null;
    if (result === 1) matches.push(feature);
  }
  return matches.length === 1 ? matches[0] : null;
}

function createChinaCountyLookup({ request = axios.get, now = Date.now, project = wgs84togcj02 } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  async function boundaries(code) {
    if (!/^\d{6}$/.test(String(code))) throw new Error('无效的行政区代码');
    const cached = cache.get(code);
    if (cached && cached.expiresAt > now()) return cached.features;
    if (inFlight.has(code)) return inFlight.get(code);
    const pending = (async () => {
      const response = await request('https://geo.datav.aliyun.com/areas_v3/bound/' + code + '_full.json', {
        timeout: 2500, maxRedirects: 0, maxContentLength: 8 * 1024 * 1024
      });
      const features = response.data?.features;
      if (!Array.isArray(features) || !features.length) throw new Error('行政区边界缺失');
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(code, { features, expiresAt: now() + 24 * 60 * 60 * 1000 });
      return features;
    })();
    inFlight.set(code, pending);
    try { return await pending; } finally { inFlight.delete(code); }
  }

  return async function lookupChinaCounty(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 0 || lat > 56 || lon < 72 || lon > 138) return null;
    // Browser coordinates are WGS84; DataV boundary data uses GCJ-02.
    const point = project(lon, lat);
    let code = 100000, province = '', city = '';
    const visited = new Set();
    for (let depth = 0; depth < 3; depth++) {
      if (visited.has(code)) return null;
      visited.add(code);
      const feature = containingFeature(point, await boundaries(code));
      const props = feature?.properties;
      if (!props || typeof props.name !== 'string') return null;
      if (props.level === 'province') province = props.name;
      else if (props.level === 'city') city = props.name;
      else if (props.level === 'district' && province) {
        const municipality = /^(北京|天津|上海|重庆)市?$/.test(province) ? province : '';
        return {
          country: '中国', country_code: 'cn', state: province,
          ...(city || municipality ? { city: city || municipality } : {}),
          county: props.name, county_adcode: String(props.adcode), county_source: 'datav-boundary'
        };
      } else return null;
      code = props.adcode;
    }
    return null;
  };
}

module.exports = { createChinaCountyLookup, classifyGeometry, containingFeature };
