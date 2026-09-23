const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${location.host}`);
const canvas = document.getElementById('timerCanvas');
const ctx = canvas.getContext('2d');

let myLat = 26.0753; 
let myLon = 119.3062;
let currentDevicesState = {};

// 永久锁定机制：用“期望状态”记录操作，直到服务器数据真实同步才解锁
let pendingDeviceStates = {};

// 折线图实例
let weatherChart = null; 
let todayWeatherSnapshot = null;
let weatherFetchPromise = null;
let avatarRecognition = null;
let avatarSilenceTimer = null;
let avatarModelSourceIndex = 0;
let speechInProgress = false;
let globalVoiceHideTimer = null;
const AVATAR_INITIAL_TIMEOUT_MS = 6000;
const AVATAR_SILENCE_TIMEOUT_MS = 1200;
let deviceDemoActive = false;
let deviceDemoFlushTimer = null;
let deviceDemoTimers = [];
const deviceDemoQueue = [];
const previousDeviceState = {};

window.onload = () => {
  const savedKey = sessionStorage.getItem('agentApiKey') || localStorage.getItem('agentApiKey');
  const savedProvider = localStorage.getItem('agentProvider') || 'deepseek';
  const savedLevel = localStorage.getItem('agentLevel') || 'low';
  
  if (savedKey) document.getElementById('apiKeyInput').value = savedKey;
  document.querySelector(`input[name="provider"][value="${savedProvider}"]`).checked = true;
  document.querySelector(`input[name="level"][value="${savedLevel}"]`).checked = true;
  updatePlaceholder();
  updateAgentConnectionState();

  initLocationAndWeather();
};

function initLocationAndWeather() {
  const locDisplay = document.getElementById('location-display');
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        myLat = pos.coords.latitude;
        myLon = pos.coords.longitude;
        await reverseGeocode(myLat, myLon); 
        fetchHourlyWeather(); 
        fetchWeather();       
      },
      async (err) => {
        if (locDisplay) locDisplay.innerText = `📍 未授权定位，默认: 中国-福建省-福州市 [经度: ${myLon.toFixed(2)}, 纬度: ${myLat.toFixed(2)}]`;
        fetchHourlyWeather();
        fetchWeather();
      },
      { timeout: 5000 }
    );
  } else {
    fetchHourlyWeather();
    fetchWeather();
  }
}

async function reverseGeocode(lat, lon) {
  const locDisplay = document.getElementById('location-display');
  if (!locDisplay) return;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1&accept-language=zh-CN`);
    const data = await res.json();
    if (data && data.address) {
      const ad = data.address;
      const addrStr = [ad.country || '中国', ad.state || ad.province || '', ad.city || ad.town || ad.county || '', ad.suburb || ad.district || ''].filter(Boolean).join('-');
      locDisplay.innerText = `📍 ${addrStr} [经度: ${lon.toFixed(2)}, 纬度: ${lat.toFixed(2)}]`;
    } else {
      locDisplay.innerText = `📍 定位成功 [经度: ${lon.toFixed(2)}, 纬度: ${lat.toFixed(2)}]`;
    }
  } catch(e) {
    locDisplay.innerText = `📍 定位成功 (解析失败) [经度: ${lon.toFixed(2)}, 纬度: ${lat.toFixed(2)}]`;
  }
}

// ==== AI 管家在线 / 离线状态（是否已配置可用 API Key）====
const AGENT_ONLINE_CAPTION = { title: '管家在线', text: '先生，随时听候您的差遣。' };
const AGENT_OFFLINE_CAPTION = { title: '管家离线', text: '还没有接入大模型密钥，请到「设置」页填入 API Key 并保存。' };
let agentOfflineState = null;

// 取值优先级：输入框 > 本标签页临时密钥 > 永久保存的密钥
function getEffectiveApiKey() {
  const field = document.getElementById('apiKeyInput');
  const typed = field ? field.value.trim() : '';
  if (typed) return typed;
  return sessionStorage.getItem('agentApiKey') || localStorage.getItem('agentApiKey') || '';
}

function isAgentOffline() { return !getEffectiveApiKey(); }
function getAgentIdleTitle() { return isAgentOffline() ? AGENT_OFFLINE_CAPTION.title : AGENT_ONLINE_CAPTION.title; }
function getAgentIdleText() { return isAgentOffline() ? AGENT_OFFLINE_CAPTION.text : AGENT_ONLINE_CAPTION.text; }

// 没有密钥：状态牌红框灰字显示离线，数字人闭眼、双手垂放腿侧，像未开机一样
function updateAgentConnectionState() {
  const offline = isAgentOffline();
  const card = document.getElementById('digitalHumanCard');
  const badge = document.getElementById('avatarOnlineBadge');
  const badgeText = badge ? badge.querySelector('.avatar-online-text') : null;

  if (card) card.classList.toggle('agent-offline', offline);
  if (badge) badge.setAttribute('aria-label', offline ? '离线：未配置 API Key' : '在线');
  if (badgeText) badgeText.innerText = offline ? '离线' : '在线';

  if (agentOfflineState === offline) return;
  agentOfflineState = offline;

  const titleEl = document.getElementById('avatarCaptionTitle');
  const statusEl = document.querySelector('.avatar-status');
  if (titleEl) titleEl.innerText = getAgentIdleTitle();
  if (statusEl) statusEl.innerText = getAgentIdleText();
}

function initApiKeyWatcher() {
  const field = document.getElementById('apiKeyInput');
  if (!field) return;
  field.addEventListener('input', updateAgentConnectionState);
}

function updatePlaceholder() {
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const input = document.getElementById('apiKeyInput');
  if (provider === 'deepseek') input.placeholder = "请输入 DeepSeek 密钥 (通常以 sk- 开头)...";
  else if (provider === 'qwen') input.placeholder = "请输入通义千问 密钥 (通常以 sk- 开头)...";
  else if (provider === 'doubao') input.placeholder = "请输入火山引擎/豆包 密钥 (纯字符，通常无 sk- 前缀)...";
}

function saveConfig(mode) {
  const key = document.getElementById('apiKeyInput').value.trim();
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const level = document.querySelector('input[name="level"]:checked').value;
  
  localStorage.setItem('agentProvider', provider);
  localStorage.setItem('agentLevel', level);

  if (mode === 'permanent') {
    if (key) localStorage.setItem('agentApiKey', key);
    else localStorage.removeItem('agentApiKey');
    sessionStorage.removeItem('agentApiKey'); 
  } else if (mode === 'session') {
    if (key) sessionStorage.setItem('agentApiKey', key);
    else sessionStorage.removeItem('agentApiKey');
    localStorage.removeItem('agentApiKey'); 
  }
  
  updateAgentConnectionState();

  const status = document.getElementById('saveStatus');
  status.innerText = mode === 'permanent' ? '✓ 配置已永久保存' : '✓ 密钥仅本次有效';
  status.style.display = 'inline-block';
  setTimeout(() => status.style.display = 'none', 2000);
}

function switchPage(pageId, element) {
  document.querySelectorAll('.page-view').forEach(page => page.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
  document.getElementById(`page-${pageId}`).classList.add('active');
  element.classList.add('active');
  if (pageId === 'weather') fetchWeather();
}

function toggleTheme() { document.body.classList.toggle('dark-mode'); }

function getWeatherInfo(code) {
  const value = Number(code);
  if (value === 0) return { text: '晴朗', icon: '☀️' };
  if ([1, 2].includes(value)) return { text: '多云', icon: '⛅' };
  if (value === 3) return { text: '阴天', icon: '☁️' };
  if ([45, 48].includes(value)) return { text: '有雾', icon: '🌫️' };
  if ([51, 53, 55, 56, 57].includes(value)) return { text: '毛毛雨', icon: '🌦️' };
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return { text: '下雨', icon: '🌧️' };
  if ([71, 73, 75, 77, 85, 86].includes(value)) return { text: '下雪', icon: '❄️' };
  if ([95, 96, 99].includes(value)) return { text: '雷雨', icon: '⛈️' };
  return { text: '多云', icon: '⛅' };
}

function isWeatherQuestion(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  return /(今天|今日|现在|当前|外面).*(天气|气温|温度|下雨|晴天|多云)/.test(compact)
    || /天气情况|天气怎么样|天气如何/.test(compact);
}

function buildWeatherNarrative(snapshot) {
  const dailyInfo = getWeatherInfo(snapshot.dailyCode);
  const currentInfo = getWeatherInfo(snapshot.currentCode);
  const maxTemp = Math.round(snapshot.maxTemp);
  const minTemp = Math.round(snapshot.minTemp);
  const currentTemp = Math.round(snapshot.currentTemp);

  let advice = '当前气温较为舒适，适合适当外出活动';
  if (currentTemp > 30) advice = '此时气温较高，出门注意防晒';
  else if (currentTemp < 20) advice = '此时气温较低，出门注意保暖';

  return `今天的天气情况是${dailyInfo.text}。全天最高气温${maxTemp}摄氏度，最低气温${minTemp}摄氏度。此刻天气${currentInfo.text}，气温${currentTemp}摄氏度。${advice}。`;
}

async function getTodayWeatherSnapshot() {
  const isFresh = todayWeatherSnapshot
    && Date.now() - todayWeatherSnapshot.fetchedAt < 5 * 60 * 1000;
  if (isFresh) return todayWeatherSnapshot;
  return fetchWeather();
}

const TASK_PRESETS = {
  '倒垃圾': 10,
  '晒衣服': 30,
  '晾衣服': 30,
  '收衣服': 10,
  '洗衣服': 45,
  '浇花': 10,
  '拖地': 20,
  '扫地': 20,
  '洗碗': 15,
  '擦桌子': 10,
  '整理房间': 30
};

// 解析 10s / 10秒 / 5分钟 / 1小时 这类相对时长，返回秒数与用户原始写法
function parseRelativeDelay(compact) {
  const match = compact.match(/(\d{1,4})(秒钟|秒|seconds|second|secs|sec|s|minutes|minute|mins|min|分钟|分|hours|hour|hrs|hr|小时|h)(之后|以后|后)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!amount) return null;
  const unit = String(match[2]).toLowerCase();
  let seconds = amount * 60;
  if (unit.indexOf('秒') === 0 || ['s', 'sec', 'secs', 'second', 'seconds'].indexOf(unit) >= 0) seconds = amount;
  else if (unit.indexOf('分') === 0 || ['min', 'mins', 'minute', 'minutes'].indexOf(unit) >= 0) seconds = amount * 60;
  else seconds = amount * 3600;
  return { seconds: seconds, raw: match[1] + match[2], hasAfter: Boolean(match[3]) };
}

// 从 10s后提醒我洗衣服 这类句子里取出提醒内容
function extractReminderName(compact) {
  let name = compact.replace(/(\d{1,4})(秒钟|秒|seconds|second|secs|sec|s|minutes|minute|mins|min|分钟|分|hours|hour|hrs|hr|小时|h)(之后|以后|后)?/i, '');
  name = name.replace(/(提醒我一下|提醒我|提醒你|提醒一下|提醒|记得|到时候|叫我|通知我|告诉我)/g, '');
  name = name.replace(/(帮我|请|麻烦|给我|替我|把|将)/g, '');
  name = name.replace(/[，。！？、,.!?;；:：]/g, '');
  name = name.replace(/^(我|你|一下|去|要|该)/, '');
  return name.trim();
}

function parseLocalTaskCommand(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  const isRemind = /提醒|记得|叫我|通知我|告诉我/.test(compact);
  const delay = parseRelativeDelay(compact);
  const presetName = Object.keys(TASK_PRESETS).find(name => compact.includes(name));
  const delayUsable = Boolean(delay) && Boolean(delay.hasAfter || isRemind);

  // 例如 10s后提醒我倒垃圾：先倒计时，到点再语音提醒
  if (delayUsable && (isRemind || presetName)) {
    const reminderName = extractReminderName(compact) || presetName || '这件事';
    return {
      name: reminderName,
      seconds: delay.seconds,
      execute: 'now',
      scheduledTime: '',
      reminder: true,
      speak: '好的，' + delay.raw + '后提醒你' + reminderName + '。'
    };
  }

  if (!presetName) return null;

  let execute = 'now';
  let scheduledTime = '';
  const timeMatch = compact.match(/(今天|明天)?(上午|下午|晚上)?(\d{1,2})(?:点|:|：)(\d{1,2})?/);
  if (timeMatch) {
    let hour = Number(timeMatch[3]);
    const minute = Number(timeMatch[4] || 0);
    if ((timeMatch[2] === '下午' || timeMatch[2] === '晚上') && hour < 12) hour += 12;
    scheduledTime = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
    execute = 'scheduled';
  } else if (/稍后|待会|等会|晚点|一会儿/.test(compact)) {
    scheduledTime = '稍后';
    execute = 'scheduled';
  }

  const name = presetName === '晾衣服' ? '晒衣服' : presetName;
  return {
    name: name,
    minutes: TASK_PRESETS[presetName],
    execute: execute,
    scheduledTime: scheduledTime,
    reminder: false,
    speak: execute === 'scheduled'
      ? '好的，已安排在' + scheduledTime + '执行' + name + '。'
      : '好的，现在开始' + name + '。'
  };
}

// 任务到点时由服务端推送，这里负责播报
function handleTaskDone(task) {
  if (!task) return;
  const text = task.text || (task.reminder ? '现在要去' + task.name + '了' : task.name + '任务已完成');
  showGlobalVoiceStatus('任务提醒', text, 'speaking');
  agentSpeak(text);
}

// ==== 倒计时框控制：暂停 / 继续 / 清除 / 延长 / 提前 ====
let pendingReports = [];
let missedReportsAnnounced = false;

function parseTaskControlCommand(text) {
  const compact = String(text || '').replace(/\s+/g, '');
  const delay = parseRelativeDelay(compact);
  const amount = delay && delay.seconds ? delay.seconds : 0;

  if (/暂停/.test(compact)) return { action: 'pause', seconds: 0 };
  if (/继续|恢复|接着计/.test(compact)) return { action: 'resume', seconds: 0 };
  if (/(清除|清空|取消)/.test(compact) && /(任务|倒计时)/.test(compact)) return { action: 'cancel', seconds: 0 };
  if (/延长|增加|加长|加时/.test(compact)) return { action: 'extend', seconds: amount || 300 };
  if (/提前/.test(compact)) return { action: 'advance', seconds: amount || 300 };
  return null;
}

async function controlTask(action, seconds) {
  try {
    const res = await fetch('/api/task_control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, seconds: seconds || 0 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '任务操作失败');
    const text = data.message || '操作完成';
    showGlobalVoiceStatus('任务控制', text, 'idle');
    agentSpeak(text);
  } catch (error) {
    const text = error.message || '任务操作失败';
    showGlobalVoiceStatus('任务控制失败', text, 'idle');
    agentSpeak(text);
  }
}

// ==== 数字人任务报告 ====
function toggleReportPanel() {
  const panel = document.getElementById('taskReportPanel');
  const btn = document.getElementById('taskReportBtn');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) btn.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
}

async function markReportRead(id) {
  try {
    await fetch('/api/report_read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    });
  } catch (error) {
    console.warn('报告已读失败', error);
  }
}

async function markAllReportsRead() {
  try {
    await fetch('/api/report_read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true })
    });
  } catch (error) {
    console.warn('报告已读失败', error);
  }
}

function renderTaskReports(reports) {
  const countBadge = document.getElementById('taskReportCount');
  const listEl = document.getElementById('taskReportList');
  const unread = reports.filter(report => !report.read);
  pendingReports = unread;

  if (countBadge) {
    countBadge.hidden = unread.length === 0;
    countBadge.innerText = String(unread.length);
  }

  if (listEl) {
    listEl.onclick = function (event) {
      const target = event.target;
      const reportId = target && target.getAttribute ? target.getAttribute('data-report-id') : null;
      if (reportId) markReportRead(reportId);
    };

    if (!reports.length) {
      listEl.innerHTML = '<p class=\'task-report-empty\'>暂无任务报告</p>';
    } else {
      listEl.innerHTML = reports.map(report => {
        const time = new Date(report.missedAt).toLocaleTimeString().slice(0, 5);
        const button = report.read ? '' : '<button type=\'button\' class=\'task-report-read\' data-report-id=\'' + report.id + '\'>阅读</button>';
        return '<div class=\'task-report-item' + (report.read ? '' : ' is-unread') + '\'>'
          + '<div class=\'task-report-meta\'><strong>' + escapeHtml(report.name) + '</strong><span>' + time + '</span></div>'
          + '<p>' + escapeHtml(report.detail || report.text || '') + '</p>'
          + button
          + '</div>';
      }).join('');
    }
  }

  announceMissedReports();
}

function announceMissedReports() {
  if (missedReportsAnnounced) return;
  if (isAgentOffline()) return;
  if (!pendingReports.length) return;
  missedReportsAnnounced = true;
  const text = pendingReports.length > 1
    ? '你有' + pendingReports.length + '项任务没有按时完成，请查看任务报告'
    : '你有一项任务没有按时完成，请查看任务报告';
  setTimeout(() => agentSpeak(text), 800);
}

async function sendVoiceCommand() {
  const text = document.getElementById('userInput').value;
  if (!text) {
    showGlobalVoiceStatus('没有听清', '请点击“呼唤管家”后重新说出指令。', 'idle');
    hideGlobalVoiceStatus();
    return;
  }

  if (isWeatherQuestion(text)) {
    document.getElementById('userInput').value = '';
    showGlobalVoiceStatus('管家查询中', '正在获取今天的天气情况...', 'thinking');
    const snapshot = await getTodayWeatherSnapshot();
    if (!snapshot) {
      agentSpeak("抱歉，我暂时无法获取今天的天气情况，请检查网络或稍后再试。");
      return;
    }
    agentSpeak(buildWeatherNarrative(snapshot));
    return;
  }

  const controlCommand = parseTaskControlCommand(text);
  if (controlCommand) {
    document.getElementById('userInput').value = '';
    showGlobalVoiceStatus('任务控制', '正在执行任务操作...', 'thinking');
    await controlTask(controlCommand.action, controlCommand.seconds);
    return;
  }

  const localTask = parseLocalTaskCommand(text);
  if (localTask) {
    document.getElementById('userInput').value = '';
    showGlobalVoiceStatus('任务安排中', `正在安排“${localTask.name}”...`, 'thinking');

    try {
      const res = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: localTask.name,
          minutes: localTask.minutes,
          seconds: localTask.seconds,
          execute: localTask.execute,
          scheduledTime: localTask.scheduledTime,
          reminder: localTask.reminder
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '任务创建失败');

      agentSpeak(localTask.speak);
    } catch (error) {
      showGlobalVoiceStatus('任务创建失败', error.message || '请稍后再试。', 'idle');
      hideGlobalVoiceStatus();
    }
    return;
  }

  const apiKey = document.getElementById('apiKeyInput').value;
  const provider = document.querySelector('input[name="provider"]:checked').value;
  const level = document.querySelector('input[name="level"]:checked').value;

  document.getElementById('userInput').value = '';
  console.log(`[发送指令]: "${text}"`);
  showGlobalVoiceStatus('管家思考中', `正在理解：“${text}”`, 'thinking');
  
  const statusEl = document.querySelector('.avatar-status');
  if (statusEl) statusEl.innerText = "正在为您思考，请稍候...";

  try {
    const res = await fetch('/api/interact', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ text, llmConfig: { apiKey, provider, level } }) 
    });
    const data = await res.json();
    if (data.reply) agentSpeak(data.reply);
    else {
      showGlobalVoiceStatus('没有回应', '管家暂时没有生成有效回复。', 'idle');
      hideGlobalVoiceStatus();
    }
  } catch (error) {
    if (statusEl) statusEl.innerText = "抱歉，网络连接或大模型调用出现了异常。";
    showGlobalVoiceStatus('连接异常', '网络连接或大模型调用出现了异常。', 'idle');
    hideGlobalVoiceStatus();
  }
}

// 拨动开关，锁定状态并精准触发语音播报
async function toggleDevice(deviceKey, deviceName) {
  const checkbox = document.getElementById(`switch-${deviceKey}`);
  const newState = checkbox.checked ? '开启' : '关闭';
  
  pendingDeviceStates[deviceKey] = newState;
  
  try {
    await fetch('/api/toggle_device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: deviceKey, state: newState })
    });
    
    agentSpeak(`${deviceName}已经${newState}。`);
    
  } catch (error) {
    console.error("手动切换设备失败", error);
    checkbox.checked = !checkbox.checked; // 仅当网络请求彻底失败时弹回
    delete pendingDeviceStates[deviceKey]; // 解除锁定
  }
}

function setAvatarAnimation(preferredNames = []) {
  const avatar3D = document.getElementById('avatar-3d');
  const available = avatar3D?.availableAnimations || [];
  if (!available.length) return;

  const normalized = available.map(name => String(name).toLowerCase());
  let matchIndex = -1;

  for (const preferred of preferredNames) {
    matchIndex = normalized.findIndex(name => name === preferred);
    if (matchIndex >= 0) break;
  }

  if (matchIndex < 0) {
    for (const preferred of preferredNames) {
      matchIndex = normalized.findIndex(name => name.includes(preferred));
      if (matchIndex >= 0) break;
    }
  }

  if (matchIndex >= 0) avatar3D.setAttribute('animation-name', available[matchIndex]);
}

function initDigitalHuman() {
  const avatar3D = document.getElementById('avatar-3d');
  const stage = document.getElementById('avatarStage');
  if (!avatar3D) return;

  const modelSources = [
    avatar3D.getAttribute('src'),
    avatar3D.dataset.fallbackSrc,
    avatar3D.dataset.finalFallbackSrc
  ].filter(Boolean);

  avatar3D.addEventListener('load', () => {
    if (stage) stage.classList.add('avatar-model-ready');
    setAvatarAnimation(['idle', 'stand', 'standing']);
  });

  avatar3D.addEventListener('error', () => {
    avatarModelSourceIndex += 1;
    if (avatarModelSourceIndex >= modelSources.length) {
      if (stage) stage.classList.add('avatar-model-failed');
      return;
    }

    if (stage) stage.classList.remove('avatar-model-ready');
    avatar3D.setAttribute('src', modelSources[avatarModelSourceIndex]);
  });
}

function showGlobalVoiceStatus(title, text, state = 'idle') {
  const panel = document.getElementById('globalVoicePanel');
  const titleEl = document.getElementById('globalVoiceTitle');
  const textEl = document.getElementById('globalVoiceText');
  if (!panel) return;

  clearTimeout(globalVoiceHideTimer);
  globalVoiceHideTimer = null;
  if (titleEl) titleEl.innerText = title;
  if (textEl) textEl.innerText = text || '';
  panel.dataset.state = state;
  panel.classList.add('is-visible');
  panel.setAttribute('aria-hidden', 'false');
}

function hideGlobalVoiceStatus(force = false) {
  const panel = document.getElementById('globalVoicePanel');
  if (!panel) return;

  clearTimeout(globalVoiceHideTimer);
  const closePanel = () => {
    panel.classList.remove('is-visible');
    panel.setAttribute('aria-hidden', 'true');
  };

  if (force) closePanel();
  else globalVoiceHideTimer = setTimeout(closePanel, 1800);
}

function summonButler() {
  if (avatarRecognition) {
    avatarRecognition.stop();
    showGlobalVoiceStatus('呼唤管家', '正在结束本次语音识别...', 'thinking');
    return;
  }

  showGlobalVoiceStatus('呼唤管家', '请说出您的指令，例如“打开客厅灯”。', 'listening');
  startAvatarListening();
}

function getDeviceDemoConfig(deviceKey) {
  const labels = {
    door_main: '大门',
    door_bedroom: '卧室门',
    door_toilet: '厕所门',
    door_balcony: '阳台门',
    light_living: '客厅灯',
    light_bedroom: '卧室灯',
    light_kitchen: '厨房灯',
    light_toilet: '厕所灯',
    light_balcony: '阳台灯',
    window_living: '客厅窗',
    window_bedroom: '卧室窗',
    window_kitchen: '厨房窗',
    ac: '空调',
    water_heater: '热水器',
    kettle: '煮水设备',
    washer: '洗衣机',
    tv: '电视',
    fan: '风扇'
  };

  if (deviceKey.startsWith('light_')) return { type: 'light', action: 'pull', label: labels[deviceKey] || '照明设备' };
  if (deviceKey.startsWith('window_')) return { type: 'window', action: 'push', label: labels[deviceKey] || '窗户' };
  if (deviceKey.startsWith('door_')) return { type: 'door', action: 'push', label: labels[deviceKey] || '门' };
  if (deviceKey === 'fan') return { type: 'fan', action: 'remote', label: '风扇' };
  if (deviceKey === 'ac') return { type: 'ac', action: 'remote', label: '空调' };
  if (deviceKey === 'kettle') return { type: 'kettle', action: 'remote', label: '煮水设备' };
  if (deviceKey === 'tv') return { type: 'tv', action: 'remote', label: '电视' };
  if (deviceKey === 'washer') return { type: 'washer', action: 'remote', label: '洗衣机' };
  return { type: 'generic', action: 'remote', label: labels[deviceKey] || '智能设备' };
}

function getDeviceDemoBody(type) {
  if (type === 'light') {
    return `
      <div class="demo-lamp" data-device-visual>
        <div class="demo-lamp-cord"></div>
        <div class="demo-bulb"></div>
      </div>`;
  }

  if (type === 'window') {
    return `
      <div class="demo-window" data-device-visual>
        <div class="demo-window-sash"></div>
      </div>`;
  }

  if (type === 'fan') {
    return `
      <div class="demo-fan" data-device-visual>
        <div class="demo-fan-cage">
          <div class="demo-fan-blades">
            <span></span><span></span><span></span><span></span>
          </div>
        </div>
        <div class="demo-fan-stand"></div>
      </div>`;
  }

  if (type === 'ac') {
    return `
      <div class="demo-ac" data-device-visual>
        <div class="demo-ac-body">
          <span class="demo-ac-display"></span>
          <span class="demo-ac-vent"></span>
        </div>
      </div>`;
  }

  if (type === 'tv') {
    return `
      <div class="demo-tv" data-device-visual>
        <div class="demo-tv-screen"></div>
        <div class="demo-tv-stand"></div>
      </div>`;
  }

  if (type === 'washer') {
    return `
      <div class="demo-washer" data-device-visual>
        <span class="demo-washer-panel"></span>
        <div class="demo-washer-door">
          <div class="demo-washer-drum"></div>
        </div>
      </div>`;
  }

  if (type === 'kettle') {
    return `
      <div class="demo-kettle" data-device-visual>
        <span class="demo-kettle-cord"></span>
        <span class="demo-kettle-plug"></span>
        <span class="demo-kettle-lid"></span>
        <span class="demo-kettle-body"></span>
        <span class="demo-kettle-handle"></span>
        <span class="demo-kettle-base"></span>
        <span class="demo-kettle-switch"><i></i></span>
        <span class="demo-kettle-light"></span>
        <span class="demo-kettle-coil"></span>
        <span class="demo-kettle-steam steam-one"></span>
        <span class="demo-kettle-steam steam-two"></span>
        <span class="demo-kettle-steam steam-three"></span>
      </div>`;
  }

  if (type === 'door') {
    return `
      <div class="demo-door" data-device-visual>
        <div class="demo-door-frame"></div>
        <div class="demo-door-panel"></div>
      </div>`;
  }

  return `<div class="demo-generic" data-device-visual></div>`;
}

function setDeviceDemoVisual(scene, type, isOn, instant = false) {
  const visual = scene.querySelector('[data-device-visual]');
  if (!visual) return;

  if (type === 'light') {
    visual.querySelector('.demo-bulb')?.classList.toggle('is-on', isOn);
  } else if (type === 'window' || type === 'ac' || type === 'tv' || type === 'washer' || type === 'kettle' || type === 'door') {
    visual.classList.toggle('is-on', isOn);
    visual.classList.toggle('is-open', isOn);
  } else if (type === 'fan') {
    const blades = visual.querySelector('.demo-fan-blades');
    if (!blades) return;
    blades.classList.remove('is-spinning', 'is-stopping');
    if (isOn) blades.classList.add('is-spinning');
    else if (!instant) blades.classList.add('is-stopping');
  } else {
    visual.classList.toggle('is-on', isOn);
  }
}

function setDeviceDemoButton(scene, isOn) {
  const button = scene.querySelector('.demo-control-button');
  const label = scene.querySelector('.demo-control-label');
  if (!button) return;
  button.classList.toggle('is-on', isOn);
  button.classList.toggle('is-off', !isOn);
  if (label) label.textContent = isOn ? '开启' : '关闭';
}

function queueDeviceDemo(deviceKey, nextState, previousState) {
  if (nextState === previousState) return;
  deviceDemoQueue.push({ deviceKey, nextState, previousState });
  clearTimeout(deviceDemoFlushTimer);
  deviceDemoFlushTimer = setTimeout(flushDeviceDemoQueue, 420);
}

function flushDeviceDemoQueue() {
  if (speechInProgress || deviceDemoActive || !deviceDemoQueue.length) return;
  playDeviceDemo(deviceDemoQueue.shift());
}

function playDeviceDemo(event) {
  const layer = document.getElementById('deviceDemoLayer');
  const stage = document.getElementById('avatarStage');
  if (!layer || !stage) return;

  const config = getDeviceDemoConfig(event.deviceKey);
  const nextOn = event.nextState === '开启';
  const initialOn = event.previousState === '开启';
  const scene = document.createElement('div');
  scene.className = `demo-scene demo-device-${config.type}`;
  scene.innerHTML = `
    <div class="demo-prop">
      <div class="demo-caption">${config.label}</div>
      <div class="demo-control-button ${initialOn ? 'is-on' : 'is-off'}">
        <span class="demo-control-dot"></span>
        <span class="demo-control-label">${initialOn ? '开启' : '关闭'}</span>
      </div>
      ${getDeviceDemoBody(config.type)}
    </div>
    <div class="demo-timer"></div>`;

  deviceDemoActive = true;
  layer.replaceChildren(scene);
  setDeviceDemoVisual(scene, config.type, initialOn, true);
  stage.classList.add('demo-is-active', `demo-action-${config.action}`);
  requestAnimationFrame(() => scene.classList.add('is-visible'));

  const controlButton = scene.querySelector('.demo-control-button');
  const kettleSwitch = scene.querySelector('.demo-kettle-switch');
  deviceDemoTimers = [
    setTimeout(() => {
      controlButton?.classList.add('is-pressed');
      kettleSwitch?.classList.add('is-pressed');
    }, 380),
    setTimeout(() => {
      controlButton?.classList.remove('is-pressed');
      kettleSwitch?.classList.remove('is-pressed');
      setDeviceDemoVisual(scene, config.type, nextOn);
      setDeviceDemoButton(scene, nextOn);
      scene.classList.toggle('is-pulling', config.type === 'light');
    }, 760),
    setTimeout(() => closeDeviceDemo(scene, stage, layer, config.action), 3000)
  ];
}

function closeDeviceDemo(scene, stage, layer, action) {
  deviceDemoTimers.forEach(clearTimeout);
  deviceDemoTimers = [];
  scene.classList.remove('is-visible');
  scene.classList.add('is-leaving');
  stage.classList.remove('demo-is-active', `demo-action-${action}`);

  setTimeout(() => {
    if (layer.firstChild === scene) layer.replaceChildren();
    deviceDemoActive = false;
    flushDeviceDemoQueue();
  }, 360);
}

function greetDigitalHuman() {
  agentSpeak("您好，我是您的 3D AI 管家。您可以让我控制灯光、门窗、家电，或者为您安排定时任务。");
}

function startAvatarListening() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const stage = document.getElementById('avatarStage');
  const statusEl = document.querySelector('.avatar-status');
  const titleEl = document.getElementById('avatarCaptionTitle');

  if (!SpeechRecognition) {
    agentSpeak("当前浏览器不支持语音识别，请使用下方的文字输入框发送指令。");
    return;
  }

  if (avatarRecognition) {
    avatarRecognition.stop();
    return;
  }

  avatarRecognition = new SpeechRecognition();
  avatarRecognition.lang = 'zh-CN';
  avatarRecognition.continuous = true;
  avatarRecognition.interimResults = true;
  avatarRecognition.maxAlternatives = 1;

  let heardText = '';
  const scheduleAutoStop = (delay = AVATAR_SILENCE_TIMEOUT_MS) => {
    clearTimeout(avatarSilenceTimer);
    avatarSilenceTimer = setTimeout(() => {
      if (avatarRecognition) avatarRecognition.stop();
    }, delay);
  };

  avatarRecognition.onstart = () => {
    if (stage) stage.classList.add('listening');
    if (titleEl) titleEl.innerText = '正在聆听';
    if (statusEl) statusEl.innerText = '请说出您的指令...';
    showGlobalVoiceStatus('正在聆听', '请连续说出指令，例如“打开空调，再打开风扇”。', 'listening');
    scheduleAutoStop(AVATAR_INITIAL_TIMEOUT_MS);
  };

  avatarRecognition.onresult = (event) => {
    heardText = Array.from(event.results).map(result => result[0].transcript).join('');
    const input = document.getElementById('userInput');
    if (input) input.value = heardText;
    if (statusEl) statusEl.innerText = heardText || '正在识别...';
    showGlobalVoiceStatus('识别中', heardText || '正在识别语音...', 'thinking');
    scheduleAutoStop();
  };

  avatarRecognition.onerror = () => {
    clearTimeout(avatarSilenceTimer);
    avatarSilenceTimer = null;
    if (statusEl) statusEl.innerText = '没有听清，请再试一次。';
    showGlobalVoiceStatus('没有听清', '请靠近麦克风再试一次。', 'idle');
  };

  avatarRecognition.onend = () => {
    clearTimeout(avatarSilenceTimer);
    avatarSilenceTimer = null;
    if (stage) stage.classList.remove('listening');
    if (titleEl) titleEl.innerText = getAgentIdleTitle();
    avatarRecognition = null;

    if (heardText.trim()) sendVoiceCommand();
    else {
      if (statusEl) statusEl.innerText = getAgentIdleText();
      hideGlobalVoiceStatus();
    }
  };

  try {
    avatarRecognition.start();
  } catch (error) {
    clearTimeout(avatarSilenceTimer);
    avatarSilenceTimer = null;
    avatarRecognition = null;
    if (stage) stage.classList.remove('listening');
    if (statusEl) statusEl.innerText = '语音识别启动失败，请稍后再试。';
    showGlobalVoiceStatus('启动失败', '语音识别启动失败，请检查麦克风权限。', 'idle');
    hideGlobalVoiceStatus();
  }
}

async function triggerFaceDetect() {
  summonButler();
}

// 3D 动作与语音同步联动
function agentSpeak(text) {
  const statusEl = document.querySelector('.avatar-status');
  const hologramBase = document.getElementById('hologramBase');
  const stage = document.getElementById('avatarStage');
  const titleEl = document.getElementById('avatarCaptionTitle');
  
  window.speechSynthesis.cancel();
  speechInProgress = true;
  showGlobalVoiceStatus('管家回应中', text, 'speaking');
  if (statusEl) statusEl.innerText = text;
  if (titleEl) titleEl.innerText = '管家回应中';
  if (stage) stage.classList.add('speaking');
  if (hologramBase) hologramBase.classList.add('speaking'); 
  setAvatarAnimation(['wave', 'talk', 'talking', 'idle']);

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN'; 
  utterance.rate = 1.0;     
  utterance.pitch = 1.0;    
  
  utterance.onend = () => {
    speechInProgress = false;
    if (stage) stage.classList.remove('speaking');
    if (hologramBase) hologramBase.classList.remove('speaking');
    if (titleEl) titleEl.innerText = getAgentIdleTitle();
    setAvatarAnimation(['idle', 'stand', 'standing']);
    setTimeout(flushDeviceDemoQueue, 240);
    hideGlobalVoiceStatus();
    setTimeout(() => {
      if (!window.speechSynthesis.speaking && statusEl) {
        statusEl.innerText = getAgentIdleText();
      }
    }, 3000);
  };
  
  utterance.onerror = () => {
    speechInProgress = false;
    if (stage) stage.classList.remove('speaking');
    if (hologramBase) hologramBase.classList.remove('speaking');
    if (titleEl) titleEl.innerText = getAgentIdleTitle();
    setAvatarAnimation(['idle', 'stand', 'standing']);
    setTimeout(flushDeviceDemoQueue, 240);
    hideGlobalVoiceStatus();
  };
  
  window.speechSynthesis.speak(utterance);
}

initDigitalHuman();
initApiKeyWatcher();
updateAgentConnectionState();

// 渲染总览页面上方的小时天气，并同步渲染折线图
async function fetchHourlyWeather() {
  const container = document.getElementById('hourlyWeatherContainer');
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${myLat}&longitude=${myLon}&hourly=temperature_2m,weathercode&timezone=Asia%2FShanghai&forecast_days=1`);
    const data = await res.json();
    const now = new Date();
    let currentH = now.getHours();
    if (now.getMinutes() > 30) currentH = (currentH + 1) % 24;

    let hoursData = [];
    let chartLabels = [];
    let chartTemps = [];

    for (let i = 0; i < 24; i++) {
      let temp = data.hourly.temperature_2m[i];
      let code = data.hourly.weathercode[i];
      const weatherInfo = getWeatherInfo(code);
      let statusStr = weatherInfo.text;
      let icon = weatherInfo.icon;
      hoursData.push({ hour: i, label: `${i}:00`, icon: icon, status: statusStr, high: Math.round(temp + 1), low: Math.round(temp - 2), isPast: false });
      
      chartLabels.push(`${i}:00`);
      chartTemps.push(temp);
    }

    let futureAndCurrent = [], past = [];
    for (let item of hoursData) {
      if (item.hour >= currentH) futureAndCurrent.push(item);
      else { item.isPast = true; past.push(item); }
    }
    const sortedData = futureAndCurrent.concat(past);

    let html = '';
    sortedData.forEach(item => {
      let pastClass = item.isPast ? ' past' : '';
      html += `<div class="hourly-item${pastClass}"><div style="font-size: 14px; font-weight: bold; color: var(--text-main);">${item.label}</div><div style="font-size: 22px; margin: 6px 0;">${item.icon}</div><div class="text-status">${item.status}</div><div class="text-temp"><span class="temp-high">${item.high}°</span> / <span class="temp-low">${item.low}°</span></div></div>`;
    });
    if(container) container.innerHTML = html;

    // 渲染图表
    const ctxChart = document.getElementById('weatherTrendChart');
    if (ctxChart) {
      if (weatherChart) { weatherChart.destroy(); }
      weatherChart = new Chart(ctxChart, {
        type: 'line',
        data: {
          labels: chartLabels,
          datasets: [{
            label: '气温 (°C)',
            data: chartTemps,
            borderColor: '#007bff',
            backgroundColor: 'rgba(0, 123, 255, 0.1)',
            borderWidth: 2,
            pointBackgroundColor: '#fff',
            pointBorderColor: '#007bff',
            pointRadius: 3,
            fill: true,
            tension: 0.4 
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false, 
          layout: {
            padding: { top: 88, right: 18, bottom: 8, left: 8 }
          },
          plugins: { legend: { display: false } }, 
          scales: {
            x: {
              grid: { display: false },
              ticks: { autoSkip: true, maxRotation: 0 }
            }, 
            y: { grid: { color: 'rgba(0,0,0,0.05)' } }
          }
        }
      });
    }
  } catch (error) { 
    if(container) container.innerHTML = "获取小时天气失败"; 
  }
}

// 获取未来7天预报及实时气象详情
async function fetchWeather() {
  if (weatherFetchPromise) return weatherFetchPromise;

  weatherFetchPromise = (async () => {
    const container = document.getElementById('weather-container');
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${myLat}&longitude=${myLon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai`);
      const data = await res.json();
      let html = '';

      for (let i = 0; i < 7; i++) {
        const date = data.daily.time[i];
        const maxT = data.daily.temperature_2m_max[i];
        const minT = data.daily.temperature_2m_min[i];
        const code = data.daily.weathercode[i];
        const weatherInfo = getWeatherInfo(code);
        html += `<div class="weather-card"><div style="color: var(--text-sub); font-size: 12px;">${date}</div><div style="font-size: 30px; margin: 10px 0;">${weatherInfo.icon}</div><div><strong>${maxT}°</strong> / ${minT}°</div></div>`;
      }
      if (container) container.innerHTML = html;

      if (data.current) {
        const elFeels = document.getElementById('cw-feels');
        const elHum = document.getElementById('cw-humidity');
        const elWind = document.getElementById('cw-wind');
        const elRain = document.getElementById('cw-rain');

        if (elFeels) elFeels.innerText = data.current.apparent_temperature + ' °C';
        if (elHum) elHum.innerText = data.current.relative_humidity_2m + ' %';
        if (elWind) elWind.innerText = data.current.wind_speed_10m + ' km/h';
        if (elRain) elRain.innerText = data.current.precipitation + ' mm';
      }

      todayWeatherSnapshot = {
        fetchedAt: Date.now(),
        dailyCode: data.daily.weathercode[0],
        maxTemp: data.daily.temperature_2m_max[0],
        minTemp: data.daily.temperature_2m_min[0],
        currentCode: data.current.weathercode,
        currentTemp: data.current.temperature_2m,
        apparentTemp: data.current.apparent_temperature,
        humidity: data.current.relative_humidity_2m,
        windSpeed: data.current.wind_speed_10m,
        precipitation: data.current.precipitation
      };

      return todayWeatherSnapshot;
    } catch (error) {
      if (container) container.innerHTML = "获取天气失败，请检查网络连接。";
      return null;
    } finally {
      weatherFetchPromise = null;
    }
  })();

  return weatherFetchPromise;
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'AGENT_LOG') console.log("AI状态更新: ", msg.log); 
  else if (msg.type === 'STATE_UPDATE') renderUI(msg.data);
  else if (msg.type === 'TASK_DONE') handleTaskDone(msg.data);
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

// 动态渲染设备，联动滑动开关
function renderUI(state) {
  document.getElementById('projDate').innerText = new Date().toLocaleDateString();
  document.getElementById('projClock').innerText = new Date().toTimeString().split(' ')[0];
  
  if (state.devices) {
    currentDevicesState = state.devices;
    const deviceKeys = [
      'door_main', 'door_bedroom', 'door_toilet', 'door_balcony',
      'light_living', 'light_bedroom', 'light_kitchen', 'light_toilet', 'light_balcony',
      'window_living', 'window_bedroom', 'window_kitchen',
      'ac', 'water_heater', 'kettle', 'washer', 'tv', 'fan'
    ];
    
    deviceKeys.forEach(key => {
      const el = document.getElementById(`dev-${key}`);
      const toggle = document.getElementById(`switch-${key}`); 
      const serverVal = state.devices[key] || '关闭';
      const previousVal = previousDeviceState[key];

      if (previousVal !== undefined && previousVal !== serverVal) {
        queueDeviceDemo(key, serverVal, previousVal);
      }
      previousDeviceState[key] = serverVal;

      if(el) {
        // 如果后端传来的状态已经和我们点击的期望状态一致了，解除锁定
        if (pendingDeviceStates[key] === serverVal) {
          delete pendingDeviceStates[key];
        }
        
        // 如果处于锁定状态，强制显示点击状态；否则正常显示后端最新状态
        const displayVal = pendingDeviceStates[key] ? pendingDeviceStates[key] : serverVal;
        
        el.innerText = displayVal;
        el.className = displayVal === '开启' ? 'on' : 'off';
        
        // 只有在没被锁定时，才允许后端数据去改变滑块的位置
        if(toggle && !pendingDeviceStates[key]) {
          toggle.checked = (displayVal === '开启');
        }
      }
    });
  }
  
  const taskInfo = document.getElementById('taskInfo');
  const taskNameEl = document.getElementById('taskName');
  const timeLeftEl = document.getElementById('timeLeft');
  const scheduleHintEl = document.getElementById('taskScheduleHint');
  const pendingOverlayEl = document.getElementById('pendingTaskOverlay');
  const pendingTasks = Array.isArray(state.pendingTasks) ? state.pendingTasks : [];
  const renderPendingOverlay = tasks => {
    if (!pendingOverlayEl) return;
    pendingOverlayEl.innerHTML = tasks.map(task => `
      <div class="pending-task-entry">
        <span>${escapeHtml(task.name)}</span>
        <time>${escapeHtml(task.scheduledTime || '等待')}</time>
      </div>`).join('');
  };

  if (state.activeTask) {
    const rem = state.activeTask.remaining;
    const timeStr = `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`;
    taskInfo?.classList.remove('scheduled-center');
    if (taskNameEl) taskNameEl.innerText = state.activeTask.name;
    if (timeLeftEl) timeLeftEl.innerText = timeStr;
    if (scheduleHintEl) {
      scheduleHintEl.innerText = state.activeTask.paused
        ? '已暂停'
        : (state.activeTask.startTime && state.activeTask.endTime ? state.activeTask.startTime + ' - ' + state.activeTask.endTime : '当前任务');
    }
    drawCanvas(1 - (rem / state.activeTask.totalSeconds), rem <= 300);
    renderPendingOverlay(pendingTasks);
  } else if (pendingTasks.length) {
    const nextTask = pendingTasks[0];
    taskInfo?.classList.add('scheduled-center');
    if (taskNameEl) taskNameEl.innerText = nextTask.name;
    if (timeLeftEl) timeLeftEl.innerText = nextTask.scheduledTime || '等待';
    if (scheduleHintEl) scheduleHintEl.innerText = '预计执行';
    drawCanvas(0, false);
    renderPendingOverlay(pendingTasks.slice(1));
  } else {
    taskInfo?.classList.remove('scheduled-center');
    if (taskNameEl) taskNameEl.innerText = "等待任务执行";
    if (timeLeftEl) timeLeftEl.innerText = "--:--";
    if (scheduleHintEl) scheduleHintEl.innerText = '';
    drawCanvas(0, false);
    renderPendingOverlay([]);
  }
  
  renderTaskReports(Array.isArray(state.reports) ? state.reports : []);
}

function drawCanvas(percent, isAlert) {
  ctx.clearRect(0, 0, 200, 200);
  ctx.beginPath(); ctx.arc(100, 100, 80, 0, 2 * Math.PI); ctx.strokeStyle = '#333'; ctx.lineWidth = 10; ctx.stroke();
  ctx.beginPath(); ctx.arc(100, 100, 80, -0.5 * Math.PI, (2 * Math.PI * percent) - 0.5 * Math.PI);
  ctx.strokeStyle = isAlert ? '#ff3333' : '#00ffff'; ctx.lineWidth = 10; ctx.stroke();
}
