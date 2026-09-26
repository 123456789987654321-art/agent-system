import { OfficialAvatarController } from './avatar-controller.mjs?v=xmov-20260926-1';

const host = document.getElementById('avatar-3d');
const stage = document.getElementById('avatarStage');
const status = document.getElementById('avatarConnectionStatus');
const connectButton = document.getElementById('avatarConnect');
const disconnectButton = document.getElementById('avatarDisconnect');
const testButton = document.getElementById('avatarTest');
const appIdField = document.getElementById('avatarAppId');
const secretField = document.getElementById('avatarAppSecret');
const caption = stage.querySelector('.avatar-caption');
let scriptPromise, connectBusy = false;

async function request(url, { body, headers = {}, ...options } = {}) {
  const response = await fetch(url, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  if (!response.ok || data.error_code) throw new Error(data.error_reason || '官方数字人请求失败，请重试。');
  return data;
}
function loadSdk(url) {
  if (window.XmovAvatar) return Promise.resolve(window.XmovAvatar);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url; script.async = true;
    const timer = setTimeout(() => { script.remove(); scriptPromise = null; reject(new Error('官方 SDK 加载超时，请重试。')); }, 20000);
    script.onload = () => { clearTimeout(timer); if(window.XmovAvatar) resolve(window.XmovAvatar); else { scriptPromise = null; script.remove(); reject(new Error('官方 SDK 加载失败。')); } };
    script.onerror = () => { clearTimeout(timer); script.remove(); scriptPromise = null; reject(new Error('官方 SDK 加载失败，请重试。')); };
    document.head.append(script);
  });
  return scriptPromise;
}
const enabled = () => typeof window.isAgentOffline === 'function' && !window.isAgentOffline();
let lastLayout = { container: { size: [360, 640] }, avatar: { v_align: 'bottom', h_align: 'center', scale: '96vh', offset_x: 0, offset_y: 0 } };
function layout() {
  const width = host.clientWidth, height = host.clientHeight;
  if (!width || !height) return lastLayout;
  return lastLayout = { container: { size: [width, height] }, avatar: { v_align: 'bottom', h_align: 'center', scale: `${Math.min(96, width / (height * 9 / 16) * 96)}vh`, offset_x: 0, offset_y: 0 } };
}
function renderState({ state, detail }) {
  const ready = state === 'ready' && enabled();
  stage.classList.toggle('avatar-model-ready', ready);
  stage.classList.toggle('official-avatar-error', state === 'error');
  document.getElementById('avatarEmpty').hidden = ready;
  document.getElementById('avatarEmptyTitle').textContent = state === 'connecting' ? '正在连接官方数字人' : state === 'error' ? '暂未加载官方形象' : state === 'reconnecting' ? '数字人会话恢复中' : '官方数字人待配置';
  document.getElementById('avatarLoadStatus').textContent = detail || '在设置中连接官方应用，加载你选择的数字人形象。';
  status.textContent = detail || '尚未连接官方数字人';
  status.dataset.state = state;
  connectButton.disabled = !enabled() || connectBusy || state === 'connecting';
  disconnectButton.disabled = !controller.grant && state !== 'connecting';
  testButton.disabled = !ready;
  window.updateAgentConnectionState?.();
}
const controller = new OfficialAvatarController({
  request, loadSdk, isEnabled: enabled, getAgentKey: () => window.getEffectiveApiKey(),
  getContainer: () => host, getLayout: layout, onChange: renderState,
  onSpeech: active => stage.classList.toggle('speaking', active),
});

function openSettings() {
  const button = [...document.querySelectorAll('.nav-item')].find(item => item.getAttribute('onclick')?.includes("'settings'"));
  window.switchPage('settings', button);
  appIdField.focus();
}
document.getElementById('avatarSetup').addEventListener('click', openSettings);
connectButton.addEventListener('click', async () => {
  if (connectBusy) return;
  if (!enabled()) { status.textContent = '请先保存上方的大模型 API Key。'; return; }
  if (!window.isSecureContext) { status.textContent = '请通过 HTTPS 或 localhost 打开本系统后连接官方数字人。'; return; }
  const appId = appIdField.value.trim(), appSecret = secretField.value.trim();
  if (!appId || !appSecret) { status.textContent = '请填写官方驱动应用的 App ID 和 App Secret。'; return; }
  connectBusy = true; connectButton.disabled = true;
  // Clear the password field immediately; never persist it in browser storage.
  secretField.value = '';
  try {
    window.switchPage('overview', document.querySelector('.nav-item'));
    window.showOverviewPanel('avatar');
    await new Promise(requestAnimationFrame);
    await controller.connect({ appId, appSecret });
  } catch (error) { status.textContent = error.message; }
  finally { connectBusy = false; connectButton.disabled = !enabled(); }
});
disconnectButton.addEventListener('click', () => { void controller.disconnect('user'); });
testButton.addEventListener('click', async () => {
  if (!controller.ready) return;
  testButton.disabled = true;
  status.textContent = '正在等待官方数字人播报';
  try {
    const completed = await controller.speak('你好，我是你的数字人管家。官方形象和语音服务已连接。');
    status.textContent = completed ? '已收到官方播报完成回调；这项测试不代表大模型调用已验证。' : '测试播报已停止';
  } catch (error) { status.textContent = error.message; }
  finally { testButton.disabled = !controller.ready; }
});

let lastListening = false;
new MutationObserver(() => {
  const active = stage.classList.contains('listening');
  if (active !== lastListening) { lastListening = active; controller.listening(active); }
}).observe(stage, { attributes: true, attributeFilter: ['class'] });
function resize() {
  stage.style.setProperty('--avatar-caption-space', caption.offsetHeight + 20 + 'px');
  if (host.clientWidth && host.clientHeight) {
    stage.classList.toggle('avatar-compact', host.clientHeight < 180);
    controller.resize();
  }
}
new ResizeObserver(resize).observe(host);
new ResizeObserver(resize).observe(caption);
setInterval(() => { void controller.keepAlive(); }, 60000);
window.addEventListener('pagehide', () => { void controller.disconnect('page_unload'); });

window.HomeAvatar = {
  get ready() { return controller.ready; },
  speak: text => controller.speak(text),
  stopSpeech: () => controller.stopSpeech(),
  disconnect: () => controller.disconnect(),
  diagnostics: () => controller.diagnostics(),
  syncAccess: () => {
    if (!enabled() && (controller.sdk || controller.grant || controller.state === 'connecting')) void controller.disconnect('api_removed');
    connectButton.disabled = !enabled() || connectBusy || controller.state === 'connecting';
    testButton.disabled = !controller.ready;
  },
};
resize();
renderState({ state: 'unconfigured', detail: '在设置中连接官方应用，加载你选择的数字人形象。' });
