const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
function fixture() {
  return {
    utc_offset_seconds: 28800,
    hourly: {
      time: Array.from({ length: 24 }, (_, i) => `2026-10-09T${String(i).padStart(2, '0')}:00`),
      temperature_2m: Array(24).fill(20), weathercode: Array(24).fill(0)
    },
    current: { time: '2026-10-09T12:00', temperature_2m: 20 },
    daily: { time: Array(7).fill('2026-10-09'), temperature_2m_max: Array(7).fill(25),
      temperature_2m_min: Array(7).fill(15), weathercode: Array(7).fill(0) }
  };
}
function setup(fetchData = async () => fixture(), Chart) {
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', innerText: '' });
      return elements.get(id);
    } },
    console: { warn() {} }, Chart,
    myLat: 30, myLon: 120, weatherLocationVersion: 1, weatherFetchPromise: null,
    weatherChart: null, todayWeatherSnapshot: null, currentLocation: { source: 'browser' },
    validCoordinates: () => true, fetchJsonWithTimeout: fetchData,
    getWeatherInfo: () => ({ text: '晴', icon: 'sun' }), weatherIconMarkup: () => '<svg></svg>',
    applyWeatherChartTheme() {}
  });
  vm.runInContext(source.slice(source.indexOf('function resetWeatherDisplay('), source.indexOf('async function initLocationAndWeather(')), context);
  vm.runInContext(source.slice(source.indexOf('function renderHourlyWeather('), source.indexOf('function handleSocketMessage(')), context);
  return { context, elements };
}

test('hourly and daily weather share one request and refresh together without Chart', async () => {
  const urls = [];
  const { context, elements } = setup(async url => { urls.push(url); return fixture(); });
  await Promise.all([context.fetchWeather(), context.fetchWeather()]);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /hourly=temperature_2m,weathercode/);
  assert.equal((elements.get('hourlyWeatherContainer').innerHTML.match(/class="hourly-item/g) || []).length, 24);
  assert.match(elements.get('hourlyWeatherContainer').innerHTML, /20°C/);
  assert.doesNotMatch(elements.get('hourlyWeatherContainer').innerHTML, /temp-high|temp-low/);
  assert.equal((elements.get('weather-container').innerHTML.match(/class="weather-card/g) || []).length, 7);
  await context.fetchWeather();
  assert.equal(urls.length, 2);
});

test('chart construction failure does not erase hourly or daily weather', async () => {
  const { context, elements } = setup(undefined, function Chart() { throw new Error('chart unavailable'); });
  assert.ok(await context.fetchWeather());
  assert.match(elements.get('hourlyWeatherContainer').innerHTML, /20°C/);
  assert.equal(elements.get('hourlyWeatherContainer').innerText, '');
});

test('missing or null hourly data leaves daily weather usable and retries on refresh', async () => {
  let data = fixture();
  data.hourly.temperature_2m[0] = null;
  const { context, elements } = setup(async () => data);
  assert.ok(await context.fetchWeather());
  assert.match(elements.get('hourlyWeatherContainer').innerText, /逐小时预报暂不可用/);
  assert.match(elements.get('weather-container').innerHTML, /weather-card/);
  data = fixture();
  await context.fetchWeather();
  assert.match(elements.get('hourlyWeatherContainer').innerHTML, /20°C/);
});

test('an old location response cannot overwrite the new location', async () => {
  let resolve;
  const { context, elements } = setup(() => new Promise(done => { resolve = done; }));
  const pending = context.fetchWeather();
  context.weatherLocationVersion++;
  resolve(fixture());
  assert.equal(await pending, null);
  assert.equal(elements.get('weather-container').innerHTML, '');
  assert.equal(elements.has('hourlyWeatherContainer'), false);
});

test('request failures clear both forecasts and a subsequent refresh recovers', async () => {
  let fail = true;
  const { context, elements } = setup(async () => {
    if (fail) throw new Error('network');
    return fixture();
  });
  assert.equal(await context.fetchWeather(), null);
  assert.match(elements.get('weather-container').innerText, /获取天气失败/);
  assert.match(elements.get('hourlyWeatherContainer').innerText, /获取天气失败/);
  fail = false;
  assert.ok(await context.fetchWeather());
  assert.match(elements.get('hourlyWeatherContainer').innerHTML, /20°C/);
});
