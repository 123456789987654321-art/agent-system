const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

const field = line => {
  const match = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/);
  return match ? [match[1].trim(), match[2]] : null;
};
const number = value => {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

function parseWifiNetworks(text) {
  const networks = [];
  let network, radio;
  for (const line of text.split(/\r?\n/)) {
    const pair = field(line);
    if (!pair) continue;
    const [key, value] = pair;
    if (/^SSID\s+\d+$/i.test(key)) {
      network = { ssid: value, authentication: '', radios: [] };
      networks.push(network); radio = null;
    } else if (network && /^BSSID\s+\d+$/i.test(key)) {
      // Do not return access-point MAC addresses to the browser.
      radio = { signal: null, band: '', channel: null };
      network.radios.push(radio);
    } else if (network && /^(Authentication|身份验证|验证)$/i.test(key)) network.authentication = value;
    else if (radio && /^(Signal|信号)$/i.test(key)) {
      const n = number(value); radio.signal = n === null ? null : Math.max(0, Math.min(100, n));
    } else if (radio && /^(Band|频带|频段)$/i.test(key)) radio.band = value;
    else if (radio && /^(Channel|频道|信道)$/i.test(key)) radio.channel = number(value);
  }
  const merged = new Map();
  networks.forEach((n,i) => {
    const key = n.ssid ? JSON.stringify([n.ssid,n.authentication]) : 'hidden-'+i;
    if (merged.has(key)) merged.get(key).radios.push(...n.radios);
    else merged.set(key,n);
  });
  return [...merged.values()].map(n => {
    const strongest = n.radios.sort((a,b)=>(b.signal ?? -1)-(a.signal ?? -1))[0];
    return { ssid: n.ssid, hidden: !n.ssid, signal: strongest?.signal ?? null,
      authentication: n.authentication || '未知', band: strongest?.band || '',
      channel: strongest?.channel ?? null, accessPoints: n.radios.length };
  }).sort((a,b)=>(b.signal ?? -1)-(a.signal ?? -1));
}

function parseConnections(text) {
  const result = [];
  let item;
  for (const line of text.split(/\r?\n/)) {
    const pair = field(line);
    if (!pair) continue;
    const [key,value] = pair;
    if (/^(Name|名称)$/i.test(key)) { item = { state: '', ssid: '', signal: null }; result.push(item); }
    else if (item && /^(State|状态)$/i.test(key)) item.state = value;
    else if (item && /^SSID$/i.test(key)) item.ssid = value;
    else if (item && /^(Signal|信号)$/i.test(key)) item.signal = number(value);
  }
  return result.filter(n=>/^(connected|已连接)$/i.test(n.state) && n.ssid)
    .map(({ssid,signal})=>({ssid,signal}));
}

function failureReason(text) {
  if (/location|位置|access.*denied|拒绝访问|权限/i.test(text)) return 'permission_required';
  if (/no wireless interface|没有无线接口|没有无线.*接口|不存在无线接口/i.test(text)) return 'no_adapter';
  if (/not running|未运行|没有运行|未启动/i.test(text)) return 'service_unavailable';
  return null;
}

async function runWlan(command) {
  // Fixed commands only. UTF-8 preserves Chinese SSIDs on Windows.
  const { stdout } = await runFile('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & "$env:SystemRoot\\System32\\netsh.exe" wlan show ' + command
  ], { windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
  return stdout;
}

function createNetworkService({ platform = process.platform, runCommand = runWlan, now = Date.now } = {}) {
  let cached, pending;
  return async function snapshot() {
    if (platform !== 'win32') return { available: false, reason: 'unsupported_system' };
    if (cached && now()-cached.time < 10000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      try {
        const [scan, interfaces] = await Promise.all([runCommand('networks mode=bssid'),runCommand('interfaces')]);
        const reason = failureReason(scan);
        if (reason) return { available: false, reason };
        if (!/(SSID\s+\d+\s*[:：]|networks? currently visible|当前.*网络|可见.*网络)/i.test(scan)) {
          return { available: false, reason: 'scan_failed' };
        }
        const connections = failureReason(interfaces) ? [] : parseConnections(interfaces);
        const networks = parseWifiNetworks(scan).map(n=>({...n,connected:!n.hidden && connections.some(c=>c.ssid===n.ssid)}));
        const value = { available: true, source: 'local_windows', scannedAt: new Date(now()).toISOString(),
          networks, connections, connectionAvailable: !failureReason(interfaces) };
        cached = { time: now(), value };
        return value;
      } catch (error) {
        return { available: false, reason: failureReason(String(error.stdout || '')+' '+String(error.stderr || '')) || (error.killed ? 'timeout' : 'scan_failed') };
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}

// A hosted server's Wi-Fi is not the visitor's Wi-Fi. Never expose it remotely,
// through a reverse proxy, or to a page using a rebinding/non-local Host header.
function isLocalNetworkRequest(req) {
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  const headers = req.headers || {};
  if (headers.forwarded || headers['x-forwarded-for'] || headers['x-forwarded-host']) return false;
  try {
    const url = new URL('http://'+headers.host);
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return false;
    if (headers.origin && new URL(headers.origin).host !== url.host) return false;
    if (headers['sec-fetch-site'] && !['same-origin','none'].includes(headers['sec-fetch-site'])) return false;
    return true;
  } catch { return false; }
}

module.exports = { createNetworkService, parseWifiNetworks, parseConnections, isLocalNetworkRequest };
