const axios = require('axios');

// Public Nominatim: identify the application, cache lookups and start at most one request/second.
function createAddressLookup({ request = axios.get, now = Date.now } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let nextRequestAt = 0;
  const ttl = 24 * 60 * 60 * 1000;

  return async function lookupAddress(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw Object.assign(new Error('无效的定位坐标'), { statusCode: 400 });
    }
    const key = lat + ',' + lon;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.address;
    if (cached) cache.delete(key);
    if (inFlight.has(key)) return inFlight.get(key);
    if (now() < nextRequestAt) {
      throw Object.assign(new Error('地址查询繁忙，请稍后重试'), { statusCode: 429 });
    }
    nextRequestAt = now() + 1000;
    const pending = (async () => {
      try {
        const response = await request('https://nominatim.openstreetmap.org/reverse', {
          params: { format: 'json', lat, lon, zoom: 14, addressdetails: 1, 'accept-language': 'zh-CN' },
          headers: { 'User-Agent': 'HomeAgentWeather/1.0 (+https://github.com/123456789987654321-art/agent-system)' },
          timeout: 7000,
          maxRedirects: 0
        });
        const address = response.data && response.data.address;
        if (!address || typeof address !== 'object' || !address.country) {
          throw new Error('地址数据缺失');
        }
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { address, expiresAt: now() + ttl });
        return address;
      } catch (error) {
        if (error.response?.status === 429) nextRequestAt = now() + 60000;
        throw Object.assign(new Error('地址服务暂不可用'), { statusCode: 502 });
      }
    })();
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      inFlight.delete(key);
    }
  };
}

module.exports = { createAddressLookup };
