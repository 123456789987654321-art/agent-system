const crypto = require('node:crypto');
const express = require('express');

const GATEWAY = 'https://nebula-agent.xingyun3d.com/user/v1/ttsa/session';
const SDK_VERSION = '2.4.0';
const LEASE_MS = 5 * 60 * 1000;

// Matches @xmov/avatar 2.4.0, src/utils/encodeToken.ts. Signing happens only
// here: neither the SDK bundle nor a browser response contains the app secret.
function signSessionRequest(appId, secret, method, data, timestamp = Math.floor(Date.now() / 1000)) {
  const compare = (a, b) => {
    const x = Array.from(a, c => c.codePointAt(0)), y = Array.from(b, c => c.codePointAt(0));
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  };
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort(compare).map(key => [key, sort(value[key])])) : value;
  const sorted = sort(data);
  const json = JSON.stringify(sorted).replace(/[^\u0000-\u007e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).replace(/ /g, '');
  const signature = crypto.createHash('md5').update(new URL(GATEWAY).pathname.toLowerCase() + method.toLowerCase() + json + secret + timestamp).digest('hex');
  return { data: sorted, headers: { 'Content-Type': 'application/json', 'X-APP-ID': appId, 'X-TOKEN': signature, 'X-TIMESTAMP': String(timestamp) } };
}

function createAvatarGateway({ fetchImpl = fetch, now = Date.now, scheduleCleanup = true } = {}) {
  const router = express.Router();
  const grants = new Map();
  const fail = (res, status, reason) => res.status(status).json({ error_code: status, error_reason: reason });
  const enqueue = (grant, action) => {
    const job = grant.queue.then(action);
    grant.queue = job.catch(() => {});
    return job;
  };
  async function upstream(grant, method, data) {
    const signed = signSessionRequest(grant.appId, grant.secret, method, data, Math.floor(now() / 1000));
    const response = await fetchImpl(GATEWAY, { method, headers: signed.headers, body: JSON.stringify(signed.data), signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok || payload.error_code) {
      // Never reflect provider messages, which may include submitted credentials.
      const code = Number(payload.error_code) || response.status || 502;
      return { error_code: code, error_reason: '官方数字人服务未接受请求，请检查应用凭据、角色配置和可用额度。' };
    }
    return payload;
  }
  async function release(grant) {
    if (!grant.started) return;
    const data = { request_id: grant.requestId, stop_reason: 'user' };
    if (grant.sessionId) data.session_id = grant.sessionId;
    const result = await upstream(grant, 'DELETE', data);
    if (result.error_code) throw new Error('Official session release was not confirmed');
    grant.started = false;
    grant.sessionId = '';
  }
  async function revoke(token, grant) {
    grants.delete(token);
    grant.revoked = true;
    try { await enqueue(grant, () => release(grant)); } finally { grant.secret = ''; }
  }
  async function sweep() {
    const expired = [...grants].filter(([, grant]) => grant.expiresAt <= now());
    await Promise.allSettled(expired.map(([token, grant]) => revoke(token, grant)));
  }
  const timer = scheduleCleanup ? setInterval(() => { void sweep(); }, 30000) : null;
  timer?.unref();

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin) {
      try { if (new URL(origin).host !== req.get('host')) return fail(res, 403, '请从当前应用页面连接数字人。'); }
      catch { return fail(res, 403, '无效的页面来源。'); }
    }
    next();
  });
  router.post('/credentials', async (req, res) => {
    const { appId, appSecret } = req.body || {};
    if (!req.get('X-Agent-Key')?.trim()) return fail(res, 401, '请先保存大模型 API Key。');
    if (typeof appId !== 'string' || typeof appSecret !== 'string' || !appId.trim() || !appSecret.trim() || appId.length > 256 || appSecret.length > 512) {
      return fail(res, 400, '请填写官方驱动应用的 App ID 和 App Secret。');
    }
    await sweep();
    if (grants.size >= 64 || [...grants.values()].filter(g => g.ip === req.ip).length >= 8) return fail(res, 429, '临时连接过多，请断开不用的页面后重试。');
    const token = crypto.randomBytes(32).toString('base64url');
    grants.set(token, { appId: appId.trim(), secret: appSecret.trim(), ip: req.ip, expiresAt: now() + LEASE_MS, requestId: crypto.randomUUID(), clientRequestId: '', sessionId: '', started: false, revoked: false, attempts: [], queue: Promise.resolve() });
    res.json({ accessToken: token, appId: appId.trim(), sdkVersion: SDK_VERSION, sdkUrl: `/vendor/xmov/avatar-${SDK_VERSION}.umd.js`, gateway: '/api/avatar/session' });
  });
  router.use((req, res, next) => {
    const token = req.get('X-Avatar-Access');
    const grant = grants.get(token);
    if (!grant || grant.revoked || grant.expiresAt <= now()) return fail(res, 401, '数字人临时凭据已失效，请重新连接。');
    req.avatarToken = token;
    req.avatarGrant = grant;
    next();
  });
  router.post('/keepalive', (req, res) => {
    req.avatarGrant.expiresAt = now() + LEASE_MS;
    res.json({ ok: true });
  });
  router.delete('/credentials', async (req, res) => {
    try { await revoke(req.avatarToken, req.avatarGrant); res.json({ ok: true }); }
    catch { fail(res, 502, '连接已停用，但服务端释放确认失败。'); }
  });
  router.post('/session', async (req, res) => {
    const grant = req.avatarGrant;
    grant.attempts = grant.attempts.filter(t => now() - t < 60000);
    if (grant.attempts.length >= 6) return fail(res, 429, '连接尝试过于频繁，请稍后重试。');
    grant.attempts.push(now());
    // Only forward the SDK's capability flags; callers cannot override the
    // service URL, credentials, avatar application or another user's session.
    const input = req.body || {};
    const clientRequestId = typeof input.request_id === 'string' ? input.request_id.slice(0, 128) : '';
    const data = { gateway_type: 'default' };
    data.config = { raw_audio: input.config?.raw_audio === true, framedata_proto_version: 2, walk_version: 3 };
    const size = input.config?.layout?.container?.size;
    const scale = input.config?.layout?.avatar?.scale;
    if (Array.isArray(size) && size.length === 2 && size.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 8192)
        && typeof scale === 'string' && /^\d+(?:\.\d+)?vh$/.test(scale) && parseFloat(scale) > 0 && parseFloat(scale) <= 100) {
      data.config.layout = { container: { size }, avatar: { v_align: 'bottom', h_align: 'center', scale, offset_x: 0, offset_y: 0 } };
    }
    try {
      const payload = await enqueue(grant, async () => {
        if (grant.revoked) return { error_code: 401, error_reason: '数字人连接已取消。' };
        if (grant.clientRequestId && grant.clientRequestId !== clientRequestId) {
          await release(grant);
          grant.requestId = crypto.randomUUID();
        }
        grant.clientRequestId = clientRequestId;
        data.request_id = grant.requestId;
        grant.started = true;
        const result = await upstream(grant, 'POST', data);
        if (result.data?.session_id) grant.sessionId = result.data.session_id;
        return result;
      });
      res.json(payload);
    } catch { fail(res, 502, '数字人服务暂不可用，请稍后重试。'); }
  });
  router.delete('/session', async (req, res) => {
    try { await enqueue(req.avatarGrant, () => release(req.avatarGrant)); res.json({ error_code: 0, data: {} }); }
    catch { fail(res, 502, '暂时无法确认数字人会话已释放。'); }
  });
  return { router, sweep, close: async () => { clearInterval(timer); await Promise.allSettled([...grants].map(([token, grant]) => revoke(token, grant))); } };
}

module.exports = { createAvatarGateway, signSessionRequest, GATEWAY, SDK_VERSION };
