export function speechMarkup(text) {
  return '<speak>' + String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])) + '</speak>';
}

// Transport and rendering are injectable so lifecycle failures can be tested
// without consuming the user's official digital-human quota.
export class OfficialAvatarController {
  constructor({ request, loadSdk, isEnabled, getAgentKey, getContainer, getLayout, onChange = () => {}, onSpeech = () => {}, timeout = 90000 }) {
    Object.assign(this, { request, loadSdk, isEnabled, getAgentKey, getContainer, getLayout, onChange, onSpeech, timeout });
    this.state = 'unconfigured';
    this.generation = 0;
    this.sdk = null;
    this.grant = null;
    this.pending = null;
    this.disconnecting = Promise.resolve();
  }
  get ready() { return this.state === 'ready' && this.isEnabled(); }
  update(state, detail = '') { this.state = state; this.onChange({ state, detail }); }
  async connect(credentials) {
    await this.disconnect('replace');
    if (!this.isEnabled()) throw new Error('请先保存大模型 API Key，再连接官方数字人。');
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.isEnabled();
    this.update('connecting', '正在申请官方数字人会话');
    let timer, rejectReady;
    try {
      const grant = await this.request('/api/avatar/credentials', { method: 'POST', headers: { 'X-Agent-Key': this.getAgentKey() }, body: credentials });
      if (!current()) { await this.revoke(grant); return false; }
      this.grant = grant;
      const SDK = await this.loadSdk(grant.sdkUrl);
      if (!current()) return false;
      let downloaded = false, online = false, resolveReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      // A callback may reject before init() returns. Attach a handler immediately.
      ready.catch(() => {});
      this.cancelConnect = () => rejectReady(new Error('连接已取消。'));
      const markReady = () => {
        if (current() && downloaded && online && this.sdk?.getSessionId()) {
          this.update('ready', '官方角色已加载');
          this.resize();
          resolveReady(true);
        }
      };
      this.sdk = new SDK({
        container: this.getContainer(), containerId: '#avatar-3d',
        appId: grant.appId, appSecret: 'server-managed', gatewayServer: grant.gateway,
        headers: { 'X-Avatar-Access': grant.accessToken },
        enableLogger: false, enableClientInterrupt: true, sentry: { enabled: false },
        config: { layout: this.getLayout() },
        // Do not render arbitrary widget HTML received from spoken content.
        onWidgetEvent() {},
        onMessage: error => {
          if (!current() || Number(error.code) === 50002) return;
          if ([50001, 50003].includes(Number(error.code)) && downloaded) {
            online = false; this.stopSpeech(); this.update('reconnecting', '数字人会话正在恢复'); return;
          }
          const failure = new Error('数字人服务暂不可用，请检查应用配置后重试。' + (Number(error.code) ? `（${Number(error.code)}）` : ''));
          rejectReady(failure);
          if (this.state === 'ready' || this.state === 'reconnecting') {
            const cleanup = this.disconnect('sdk_error'), stoppedGeneration = this.generation;
            void cleanup.then(() => { if (stoppedGeneration === this.generation) this.update('error', failure.message); });
          }
        },
        onStatusChange: status => {
          if (!current()) return;
          online = status === 0 || status === 5;
          if (online) markReady();
          else if (downloaded && status !== 6) { this.stopSpeech(); this.update('reconnecting', '数字人会话暂不可用，可断开后重新连接'); }
        },
        onSpeakStateChange: (state, id) => {
          if (!current() || !this.pending || String(id) !== this.pending.id) return;
          if (state === 'speak_start') this.onSpeech(true);
          if (state === 'speak_end') { this.finishSpeech(true); this.sdk?.interactiveidle(); }
          if (state === 'speak_error') this.finishSpeech(false, new Error('官方数字人播报失败，请重试。'));
        },
      });
      timer = setTimeout(() => rejectReady(new Error('数字人加载超时，请检查官方应用配置后重新连接。')), this.timeout);
      await Promise.race([
        this.sdk.init({ onDownloadProgress: progress => {
          if (!current()) return;
          downloaded = progress >= 100;
          this.update('connecting', `正在加载官方角色 ${Math.min(100, Math.round(progress))}%`);
          markReady();
        } }).then(() => ready),
        ready,
      ]);
      return current() && this.ready;
    } catch (error) {
      if (generation !== this.generation) return false;
      const cleanup = this.disconnect('failed'), stoppedGeneration = this.generation;
      await cleanup;
      if (stoppedGeneration === this.generation) this.update('error', error.message || '官方数字人连接失败。');
      throw error;
    } finally { clearTimeout(timer); if (generation === this.generation) this.cancelConnect = null; }
  }
  async revoke(grant) {
    if (!grant) return;
    await this.request('/api/avatar/credentials', { method: 'DELETE', headers: { 'X-Avatar-Access': grant.accessToken }, keepalive: true }).catch(() => {});
  }
  disconnect(reason = 'user') {
    ++this.generation;
    this.cancelConnect?.(); this.cancelConnect = null;
    this.stopSpeech();
    const sdk = this.sdk, grant = this.grant;
    this.sdk = null; this.grant = null;
    this.update('unconfigured', '尚未连接官方数字人');
    this.disconnecting = this.disconnecting.then(async () => {
      try { await sdk?.destroy(reason); } catch {}
      finally { await this.revoke(grant); }
    });
    return this.disconnecting;
  }
  async keepAlive() {
    const grant = this.grant;
    if (!grant) return;
    try { await this.request('/api/avatar/keepalive', { method: 'POST', headers: { 'X-Avatar-Access': grant.accessToken } }); }
    catch {
      if (this.grant !== grant) return;
      const cleanup = this.disconnect('expired'), stoppedGeneration = this.generation;
      await cleanup;
      if (stoppedGeneration === this.generation) this.update('error', '数字人临时凭据已失效，请重新填写 App Secret 后连接。');
    }
  }
  finishSpeech(completed, error) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    this.onSpeech(false);
    error ? pending.reject(error) : pending.resolve(completed);
  }
  stopSpeech() {
    this.finishSpeech(false);
    try { this.sdk?.interrupt('user'); this.sdk?.interactiveidle(); } catch {}
  }
  speak(text) {
    if (!this.ready) return Promise.reject(new Error('请先在设置中连接官方数字人，再进行语音播报。'));
    if (!String(text).trim()) return Promise.resolve(false);
    this.stopSpeech();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.finishSpeech(false, new Error('数字人播报超时，请重试。'));
        try { this.sdk?.interrupt('timeout'); this.sdk?.interactiveidle(); } catch {}
      }, Math.min(600000, Math.max(45000, String(text).length * 250 + 15000)));
      this.pending = { id, resolve, reject, timer };
      try { this.sdk.speak(speechMarkup(text), true, true, { client_speak_id: id, client_frame: 0 }); }
      catch { this.finishSpeech(false, new Error('数字人播报启动失败。')); }
    });
  }
  listening(active) { if (this.ready) active ? this.sdk.listen() : this.sdk.interactiveidle(); }
  resize() { if (this.ready) this.sdk.changeLayout(this.getLayout()); }
  diagnostics() { return { provider: 'xmov', state: this.state, ready: this.ready, sessionId: this.sdk?.getSessionId() || null }; }
}
