require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DEVICE_DEFINITIONS = [
  { key: 'door_main', name: '大门' },
  { key: 'door_bedroom', name: '卧室门' },
  { key: 'door_toilet', name: '厕所门' },
  { key: 'door_balcony', name: '阳台门' },
  { key: 'light_living', name: '客厅灯' },
  { key: 'light_bedroom', name: '卧室灯' },
  { key: 'light_kitchen', name: '厨房灯' },
  { key: 'light_toilet', name: '厕所灯' },
  { key: 'light_balcony', name: '阳台灯' },
  { key: 'window_living', name: '客厅窗' },
  { key: 'window_bedroom', name: '卧室窗' },
  { key: 'window_kitchen', name: '厨房窗' },
  { key: 'ac', name: '空调' },
  { key: 'water_heater', name: '热水器' },
  { key: 'kettle', name: '煮水设备' },
  { key: 'washer', name: '洗衣机' },
  { key: 'tv', name: '电视' },
  { key: 'fan', name: '风扇' }
];
const DEVICE_BY_KEY = new Map(DEVICE_DEFINITIONS.map(device => [device.key, device]));
const DEVICE_BY_NAME = new Map(DEVICE_DEFINITIONS.map(device => [device.name, device]));
const DEVICE_REFERENCE_PATTERN = /(灯|门|窗|空调|热水器|煮水设备|水壶|洗衣机|电视|风扇|冰箱|加湿器|扫地机|家电|电器|设备|机|器|壶|扇)/;
const DEVICE_COMMAND_STEP_DELAY_MS = 700;
let deviceCommandQueue = Promise.resolve();

// 状态机与任务记忆库 (全面扩充设备列表，默认关闭)
let homeState = {
  personHome: false,
  devices: Object.fromEntries(DEVICE_DEFINITIONS.map(device => [device.key, '关闭'])),
  activeTask: null,
  pendingTasks: [],
  reports: [],
  location: null
};

// 任务心跳检测
setInterval(() => {
  if (homeState.activeTask) {
    const runningTask = homeState.activeTask;
    if (!runningTask.paused) {
      runningTask.remaining--;
      if (runningTask.remaining <= 0) finishTask(runningTask);
    }
  }
  activateReadyTask();
  broadcastState();
}, 1000);

// 任务在服务端持续计时，页面登录与否都不影响；新页面连上先同步一次完整状态
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'STATE_UPDATE', data: homeState }));
});

function broadcastState() {
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'STATE_UPDATE', data: homeState })));
}
function broadcastLog(logText) {
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'AGENT_LOG', log: logText })));
}
function broadcastTaskDone(task, text) {
  const payload = JSON.stringify({ type: 'TASK_DONE', data: { id: task.id, name: task.name, reminder: task.reminder === true, text: text } });
  let sent = 0;
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) { c.send(payload); sent++; } });
  return sent;
}

function addReport(task, text) {
  homeState.reports.unshift({
    id: task.id + '-r',
    name: task.name,
    reminder: task.reminder === true,
    detail: text,
    text: '你有一项任务没有按时完成：' + task.name,
    missedAt: Date.now(),
    read: false
  });
  homeState.reports = homeState.reports.slice(0, 20);
  broadcastLog('[任务报告]：' + task.name + ' 在无人查看时结束，已存入报告');
}

function finishTask(task) {
  if (!task) return;
  const text = task.reminder ? '现在要去' + task.name + '了' : task.name + '任务已完成';
  recordTaskEnd(task);
  homeState.activeTask = null;
  broadcastLog('[任务完成]：' + task.name + ' 结束');
  const delivered = broadcastTaskDone(task, text);
  if (!delivered) addReport(task, text);
  broadcastState();
}

// ==== 每日报：记录任务时间段与家电开启次数，每天 0 点汇总前一天 ====
const DAILY_REPORT_KEEP_DAYS = 7;
const WEATHER_CODE_TEXT = {
  0: '晴朗', 1: '多云', 2: '多云', 3: '阴天', 45: '有雾', 48: '有雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '毛毛雨', 57: '毛毛雨',
  61: '下雨', 63: '下雨', 65: '下雨', 66: '冻雨', 67: '冻雨',
  71: '下雪', 73: '下雪', 75: '下雪', 77: '下雪',
  80: '下雨', 81: '下雨', 82: '下雨', 85: '下雪', 86: '下雪',
  95: '雷雨', 96: '雷雨', 99: '雷雨'
};
let dailyBuckets = {};
let dailyReports = [];
let lastDailyCheck = '';

function dateKeyOf(date) {
  const target = date || new Date();
  return target.getFullYear() + '-' + String(target.getMonth() + 1).padStart(2, '0') + '-' + String(target.getDate()).padStart(2, '0');
}

function currentBucket() {
  const key = dateKeyOf();
  if (!dailyBuckets[key]) dailyBuckets[key] = { tasks: [], devices: {} };
  return dailyBuckets[key];
}

// 统一的设备状态写入：开启时计入当天的开启次数
function applyDeviceState(deviceKey, state) {
  const previous = homeState.devices[deviceKey];
  homeState.devices[deviceKey] = state;
  if (state === '开启' && previous !== '开启') {
    const bucket = currentBucket();
    bucket.devices[deviceKey] = (bucket.devices[deviceKey] || 0) + 1;
  }
}

function recordTaskStart(task) {
  if (!task) return;
  const bucket = currentBucket();
  bucket.tasks.push({
    id: task.id,
    name: task.name,
    reminder: task.reminder === true,
    startTime: formatClock(new Date()),
    endTime: '',
    done: false
  });
}

function recordTaskEnd(task) {
  if (!task) return;
  const bucket = currentBucket();
  let entry = bucket.tasks.find(item => item.id === task.id);
  if (!entry) {
    entry = { id: task.id, name: task.name, reminder: task.reminder === true, startTime: task.startTime || '', endTime: '', done: false };
    bucket.tasks.push(entry);
  }
  entry.endTime = formatClock(new Date());
  entry.done = true;
}

function buildDailyReport(dateKey, bucket) {
  const parts = dateKey.split('-');
  const deviceCounts = DEVICE_DEFINITIONS
    .filter(device => bucket.devices[device.key])
    .map(device => ({ key: device.key, name: device.name, count: bucket.devices[device.key] }))
    .sort((a, b) => b.count - a.count);
  return {
    date: dateKey,
    label: parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日',
    tasks: bucket.tasks,
    devices: deviceCounts,
    weather: bucket.weather || null
  };
}

async function fetchDailyWeather(dateKey) {
  const location = homeState.location;
  if (!location) return null;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + location.lat + '&longitude=' + location.lon
      + '&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&past_days=7&forecast_days=1';
    const response = await axios.get(url, { timeout: 8000 });
    const daily = response.data && response.data.daily;
    if (!daily || !Array.isArray(daily.time)) return null;
    const index = daily.time.indexOf(dateKey);
    if (index < 0) return null;
    const code = Number(daily.weathercode[index]);
    return {
      code: code,
      text: WEATHER_CODE_TEXT[code] || '未知',
      max: daily.temperature_2m_max[index],
      min: daily.temperature_2m_min[index]
    };
  } catch (error) {
    broadcastLog('[每日报]：天气获取失败 ' + error.message);
    return null;
  }
}

async function finalizeDay(dateKey) {
  if (dailyReports.some(report => report.date === dateKey)) return;
  const bucket = dailyBuckets[dateKey];
  if (!bucket || bucket.finalizing) return;
  bucket.finalizing = true;
  bucket.weather = await fetchDailyWeather(dateKey);
  const report = buildDailyReport(dateKey, bucket);
  dailyReports.unshift(report);
  dailyReports = dailyReports.slice(0, DAILY_REPORT_KEEP_DAYS);
  delete dailyBuckets[dateKey];
  broadcastLog('[每日报]：' + report.label + ' 已生成，任务 ' + report.tasks.length + ' 条，家电 ' + report.devices.length + ' 种');
  broadcastState();
}

async function ensureDailyReports() {
  const today = dateKeyOf();
  if (lastDailyCheck === today) return;
  const pastKeys = Object.keys(dailyBuckets).filter(key => key < today);
  for (const key of pastKeys) {
    await finalizeDay(key);
  }
  lastDailyCheck = today;
}

setInterval(() => { ensureDailyReports(); }, 60000);

function normalizeCommandText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?;；:："'“”‘’]/g, '|')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9|]/g, '');
}

function getRequestedDeviceState(text) {
  const compactText = normalizeCommandText(text);
  const wantsOn = /(打开|开启|启动|开)/.test(compactText);
  const wantsOff = /(关闭|关掉|关上|关)/.test(compactText);
  if (wantsOn === wantsOff) return null;
  return wantsOn ? '开启' : '关闭';
}

function extractDeviceNameFromSegment(segment) {
  return segment
    .replace(/^(请|麻烦|帮我|给我|替我|把|将|我想|我要|现在|立即|马上|首先|先|最后|都|也)+/g, '')
    .replace(/(打开|开启|启动|关闭|关掉|关上|开|关)/g, '')
    .replace(/(一下|吧|好吗|可以吗|谢谢|呢|啊|都|也)+$/g, '')
    .replace(/^(一下|都|也)/g, '')
    .trim();
}

function parseDeviceCommandText(userInput) {
  const compactText = normalizeCommandText(userInput);
  const hasControlVerb = /(打开|开启|启动|关闭|关掉|关上|开|关)/.test(compactText);
  const hasDeviceReference = DEVICE_REFERENCE_PATTERN.test(compactText);

  if (!hasControlVerb || !hasDeviceReference) {
    return { attempted: false, valid: false, commands: [] };
  }

  const globalState = getRequestedDeviceState(compactText);
  const segments = compactText
    .split(/(?:然后|接着|随后|并且|同时|以及|再|和|与|及|\|)+/)
    .filter(Boolean);
  const commands = [];
  let inheritedState = globalState;

  for (const segment of segments) {
    const segmentState = getRequestedDeviceState(segment);
    const requestedState = segmentState || inheritedState;

    if (!requestedState) {
      return { attempted: true, valid: false, commands: [] };
    }

    inheritedState = requestedState;
    const deviceName = extractDeviceNameFromSegment(segment);
    const device = DEVICE_BY_NAME.get(deviceName);

    if (!device) {
      return { attempted: true, valid: false, commands: [] };
    }

    commands.push({ device, state: requestedState });
  }

  return {
    attempted: true,
    valid: commands.length > 0,
    commands
  };
}

function buildDeviceCommandReply(commands) {
  const commandDescriptions = commands.map(command => {
    const actionText = command.state === '开启' ? '打开' : '关闭';
    return `${actionText}${command.device.name}`;
  });

  return `好的，已经为你${commandDescriptions.join('，再')}`;
}



function wait(delay) {
  return new Promise(resolve => setTimeout(resolve, delay));
}

function enqueueDeviceCommands(commands) {
  const executeCommands = async () => {
    for (let index = 0; index < commands.length; index++) {
      const command = commands[index];
      const actionText = command.state === "开启" ? "打开" : "关闭";

      applyDeviceState(command.device.key, command.state);
      broadcastLog("[顺序执行 " + (index + 1) + "/" + commands.length + "]：" + actionText + command.device.name);
      broadcastState();

      if (index < commands.length - 1) {
        await wait(DEVICE_COMMAND_STEP_DELAY_MS);
      }
    }

    const reply = buildDeviceCommandReply(commands);
    broadcastLog("[语音控制完成]：" + reply);
    return { reply };
  };

  deviceCommandQueue = deviceCommandQueue
    .catch(() => undefined)
    .then(executeCommands);

  return deviceCommandQueue;
}

function handleExplicitDeviceCommand(userInput) {
  const parsedCommand = parseDeviceCommandText(userInput);
  if (!parsedCommand.attempted) return null;

  if (!parsedCommand.valid) {
    broadcastLog('[控制拒绝]：没有检测到存在该名称的家电');
    return { reply: '没有检测到存在该名称的家电' };
  }

  return enqueueDeviceCommands(parsedCommand.commands);
}

function getValidatedControlActions(userInput, actions) {
  const parsedCommand = parseDeviceCommandText(userInput);
  const requestedCommands = new Map(
    (parsedCommand.attempted && parsedCommand.valid ? parsedCommand.commands : [])
      .map(command => [command.device.key, command.state])
  );
  const validActions = [];
  let rejected = false;

  for (const action of Array.isArray(actions) ? actions : []) {
    if (action.type !== 'control') continue;

    const device = DEVICE_BY_KEY.get(action.device);
    const stateIsValid = action.state === '开启' || action.state === '关闭';
    const requestedState = device ? requestedCommands.get(device.key) : null;

    if (!device || !stateIsValid || requestedState !== action.state) {
      rejected = true;
      continue;
    }

    validActions.push({ device, state: action.state });
  }

  return { validActions, rejected };
}

function formatClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseScheduledAt(scheduledTime) {
  const now = new Date();
  const value = String(scheduledTime || '').trim();

  if (!value || value === '立即' || value === '马上') return now.getTime();
  if (/稍后|待会|等会|晚点/.test(value)) return now.getTime() + 30 * 60 * 1000;

  const match = value.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) {
    const target = new Date(now);
    target.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  return now.getTime() + 30 * 60 * 1000;
}

function makeTask(action) {
  const minutes = Math.max(1, Number(action.minutes) || 10);
  const secondsInput = Number(action.seconds);
  const totalSeconds = Number.isFinite(secondsInput) && secondsInput > 0 ? Math.max(1, Math.round(secondsInput)) : minutes * 60;
  const scheduledTime = String(action.scheduledTime || '').trim();
  const executeMode = action.execute === 'scheduled' || scheduledTime ? 'scheduled' : 'now';
  const scheduledAt = executeMode === 'scheduled'
    ? parseScheduledAt(scheduledTime)
    : Date.now();

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: String(action.name || '日常任务'),
    reminder: action.reminder === true,
    minutes,
    seconds: totalSeconds,
    totalSeconds,
    remaining: totalSeconds,
    executeMode,
    scheduledAt,
    scheduledTime: executeMode === 'scheduled'
      ? formatClock(new Date(scheduledAt))
      : '立即'
  };
}

function activateTask(task) {
  const startedAt = new Date();
  recordTaskStart(task);
  homeState.activeTask = {
    ...task,
    startedAt: startedAt.getTime(),
    startTime: formatClock(startedAt),
    endTime: formatClock(new Date(startedAt.getTime() + task.totalSeconds * 1000)),
    remaining: task.totalSeconds
  };
  broadcastLog(`[任务开始]：${task.name}`);
}

function activateReadyTask() {
  if (homeState.activeTask || !homeState.pendingTasks.length) return;
  homeState.pendingTasks.sort((a, b) => a.scheduledAt - b.scheduledAt);
  const nextTask = homeState.pendingTasks[0];
  if (nextTask.scheduledAt <= Date.now()) {
    homeState.pendingTasks.shift();
    activateTask(nextTask);
  }
}

function scheduleTask(action) {
  const task = makeTask(action);

  if (task.executeMode === 'now' && !homeState.activeTask) {
    activateTask(task);
    return task;
  }

  if (task.executeMode === 'now' && homeState.activeTask) {
    const queuedAt = Date.now() + homeState.activeTask.remaining * 1000;
    task.executeMode = 'scheduled';
    task.scheduledAt = queuedAt;
    task.scheduledTime = formatClock(new Date(queuedAt));
  }

  homeState.pendingTasks.push(task);
  homeState.pendingTasks.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return task;
}

// 核心：处理 Agent 推理与动态 LLM 调用
async function processAgentThought(userInput, llmConfig) {
  const explicitDeviceReply = await handleExplicitDeviceCommand(userInput);
  if (explicitDeviceReply) return explicitDeviceReply.reply;

  const apiKey = String(llmConfig?.apiKey || '').trim();
  if (!apiKey) return '请先前往设置页面，填入您的 AI 密钥。';

  const deviceNameList = DEVICE_DEFINITIONS
    .map(device => `${device.key}=${device.name}`)
    .join('、');
  const systemPrompt = `你是一个智能家居Agent。用户指令："${userInput}"
已登记且唯一允许控制的家电如下：${deviceNameList}
只有当用户明确说出上面的完整中文名称时，才允许输出对应的 control 动作。
如果用户说的设备名称不在清单中，必须拒绝控制，actions 中不得包含 control，reply 必须为“没有检测到存在该名称的家电”。
请解析并严格输出纯 JSON 格式：
{
  "reply": "对用户的语音回复",
  "actions": [
    {"type": "control", "device": "door_main|door_bedroom|door_toilet|door_balcony|light_living|light_bedroom|light_kitchen|light_toilet|light_balcony|window_living|window_bedroom|window_kitchen|ac|water_heater|kettle|washer|tv|fan", "state": "开启|关闭"},
    {"type": "set_task", "name": "倒垃圾", "minutes": 10, "execute": "now", "scheduledTime": ""},
    {"type": "set_task", "name": "晒衣服", "minutes": 30, "execute": "scheduled", "scheduledTime": "17:30"}
  ]
}
倒垃圾、晒衣服、收衣服、浇花、拖地、洗碗等不属于家电控制，必须使用 set_task。
如果用户说“现在、马上、立刻”或没有指定时间，execute 使用 now。
如果用户指定时间，execute 使用 scheduled，scheduledTime 使用 HH:mm。`;

  try {
    const tempMap = { 'low': 0.0, 'medium': 0.5, 'high': 1.0 };
    const requestTemp = tempMap[llmConfig.level] || 0.0;

    let apiUrl = '';
    let reqModel = '';
    
    if (llmConfig.provider === 'deepseek') {
      apiUrl = 'https://api.deepseek.com/chat/completions';
      reqModel = 'deepseek-chat';
    } else if (llmConfig.provider === 'qwen') {
      apiUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
      reqModel = 'qwen-plus';
    } else if (llmConfig.provider === 'doubao') {
      apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
      reqModel = 'doubao-pro-32k'; 
    }

    broadcastLog(`[请求参数] 平台: ${llmConfig.provider}, 创造力: ${requestTemp}`);

    const response = await axios.post(
      apiUrl,
      {
        model: reqModel,
        temperature: requestTemp,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: systemPrompt }]
      },
      { 
        headers: { 
          'Authorization': `Bearer ${llmConfig.apiKey}`,
          'Content-Type': 'application/json'
        } 
      }
    );

    const result = JSON.parse(response.data.choices[0].message.content);
    broadcastLog(`[AI 规划]：${JSON.stringify(result.actions)}`);

    if(result.actions) {
        const { validActions, rejected } = getValidatedControlActions(userInput, result.actions);
        validActions.forEach(({ device, state }) => {
          applyDeviceState(device.key, state);
        });

        result.actions.forEach(action => {
          if (action.type === 'set_task') {
            scheduleTask(action);
          }
        });

        if (rejected) {
          return validActions.length ? `${result.reply} 部分家电名称不存在，未执行对应控制。` : '没有检测到存在该名称的家电';
        }

        if (validActions.length) broadcastState();
    }

    return result.reply;

  } catch (err) {
    let errMsg = err.response ? err.response.data.error?.message || err.response.statusText : err.message;
    broadcastLog(`[调度失败] 检查API Key或网络。错误信息: ${errMsg}`);
    return "抱歉，调用大模型失败。";
  }
}

app.post('/api/interact', async (req, res) => {
  const { text, llmConfig } = req.body;
  const reply = await processAgentThought(text, llmConfig);
  res.json({ reply });
});

app.post('/api/task', (req, res) => {
  const { name, minutes, seconds, execute, scheduledTime, reminder } = req.body;
  if (!name) return res.status(400).json({ error: '任务名称不能为空' });

  const task = scheduleTask({
    type: 'set_task',
    name,
    minutes,
    seconds,
    execute,
    scheduledTime,
    reminder
  });
  broadcastLog(`[任务安排]：${task.name}，${task.executeMode === 'now' ? '立即执行' : `${task.scheduledTime} 执行`}`);
  broadcastState();
  res.json({ success: true, task });
});

// 前端手动点击控制开关的 API
app.post('/api/toggle_device', (req, res) => {
  const { device, state } = req.body;
  if (homeState.devices[device] !== undefined) {
    applyDeviceState(device, state);
    broadcastLog(`[手动控制]：${device} 被手动切换为 ${state}`);
    broadcastState();
    res.json({ success: true });
  } else {
    res.status(400).json({ error: "未知设备" });
  }
});

app.post('/api/face_detect', (req, res) => {
  homeState.personHome = true;
  broadcastLog("[视觉感知]：人脸识别成功，激活系统");
  res.json({ status: "ready" });
});

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value >= 3600 && value % 3600 === 0) return (value / 3600) + '小时';
  if (value >= 60 && value % 60 === 0) return (value / 60) + '分钟';
  if (value >= 60) return Math.floor(value / 60) + '分' + (value % 60) + '秒';
  return value + '秒';
}

// 倒计时框的暂停、继续、清除、延长、提前
app.post('/api/task_control', (req, res) => {
  const { action, seconds, minutes } = req.body || {};
  const task = homeState.activeTask;
  const amountSeconds = Number(seconds) > 0 ? Math.round(Number(seconds)) : Math.max(0, Math.round(Number(minutes) || 0)) * 60;
  let message = '';

  if (action === 'next') {
    if (!homeState.pendingTasks.length) return res.status(400).json({ error: '没有等待中的任务' });
    homeState.pendingTasks.sort((a, b) => a.scheduledAt - b.scheduledAt);
    const nextTask = homeState.pendingTasks.shift();
    if (task) {
      nextTask.executeMode = 'scheduled';
      nextTask.scheduledAt = Date.now() + task.remaining * 1000 + 1000;
      nextTask.scheduledTime = formatClock(new Date(nextTask.scheduledAt));
      homeState.pendingTasks.unshift(nextTask);
      message = '已把下一个任务提前到当前任务结束后立即开始：' + nextTask.name;
    } else {
      activateTask(nextTask);
      message = '已提前开始下一个任务：' + nextTask.name;
    }
    broadcastLog('[任务控制]：' + message);
    broadcastState();
    return res.json({ success: true, message: message, task: homeState.activeTask });
  }

  if (!task) return res.status(400).json({ error: '当前没有正在执行的任务' });

  if (action === 'pause') {
    task.paused = true;
    message = '已暂停' + task.name + '的倒计时';
  } else if (action === 'resume') {
    task.paused = false;
    message = '已继续' + task.name + '的倒计时';
  } else if (action === 'cancel') {
    message = '已取消当前任务：' + task.name;
    recordTaskEnd(task);
    homeState.activeTask = null;
  } else if (action === 'extend') {
    if (!amountSeconds) return res.status(400).json({ error: '请说明要延长多长时间' });
    task.totalSeconds += amountSeconds;
    task.remaining += amountSeconds;
    task.endTime = formatClock(new Date(Date.now() + task.remaining * 1000));
    message = '已把' + task.name + '延长' + formatDuration(amountSeconds);
  } else if (action === 'advance') {
    if (!amountSeconds) return res.status(400).json({ error: '请说明要提前多长时间' });
    task.totalSeconds = Math.max(1, task.totalSeconds - amountSeconds);
    task.remaining = task.remaining - amountSeconds;
    message = '已把' + task.name + '提前' + formatDuration(amountSeconds);
    if (task.remaining <= 0) finishTask(task);
  } else {
    return res.status(400).json({ error: '不支持的任务操作' });
  }

  broadcastLog('[任务控制]：' + message);
  broadcastState();
  res.json({ success: true, message: message, task: homeState.activeTask });
});

// 数字人旁边的任务报告：标记已读
app.post('/api/report_read', (req, res) => {
  const { id, all } = req.body || {};
  homeState.reports.forEach(report => {
    if (all || report.id === id) report.read = true;
  });
  broadcastState();
  res.json({ success: true, reports: homeState.reports });
});
// 浏览器把定位同步给服务端，用于生成每日报里的天气
app.post('/api/location', (req, res) => {
  const { lat, lon } = req.body || {};
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    homeState.location = { lat: latitude, lon: longitude };
  }
  res.json({ success: true });
});

// 每日报：读取与清除（下载在前端直接导出文件）
app.get('/api/daily_reports', async (req, res) => {
  await ensureDailyReports();
  res.json({ success: true, reports: dailyReports });
});

app.post('/api/daily_report_clear', (req, res) => {
  const { date, all } = req.body || {};
  if (all) dailyReports = [];
  else dailyReports = dailyReports.filter(report => report.date !== date);
  broadcastState();
  res.json({ success: true, reports: dailyReports });
});
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 演示用：随机造一份昨天的每日报，方便展示和答辩
function makeDemoDailyReport() {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const dateKey = dateKeyOf(yesterday);
  const parts = dateKey.split('-');
  const taskPool = ['倒垃圾', '晒衣服', '收衣服', '浇花', '拖地', '扫地', '洗碗', '洗衣服', '擦桌子', '整理房间'];
  const deviceKeys = ['light_living', 'light_bedroom', 'light_kitchen', 'light_toilet', 'ac', 'tv', 'washer', 'water_heater', 'fan', 'kettle'];
  const devicePool = DEVICE_DEFINITIONS.filter(device => deviceKeys.indexOf(device.key) >= 0);

  const pickedTasks = taskPool.slice().sort(() => Math.random() - 0.5).slice(0, randomInt(2, 4));
  const tasks = pickedTasks.map((name, index) => {
    const startMinutes = randomInt(7 * 60, 21 * 60);
    const duration = randomInt(10, 40);
    const start = new Date(yesterday);
    start.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    return {
      id: 'demo-' + dateKey + '-' + index,
      name: name,
      reminder: false,
      startTime: formatClock(start),
      endTime: formatClock(end),
      done: true
    };
  }).sort((a, b) => (a.startTime < b.startTime ? -1 : 1));

  const devices = devicePool.slice().sort(() => Math.random() - 0.5).slice(0, randomInt(1, 3))
    .map(device => ({ key: device.key, name: device.name, count: randomInt(1, 6) }))
    .sort((a, b) => b.count - a.count);

  const codes = [0, 1, 2, 3, 61, 80];
  const code = codes[randomInt(0, codes.length - 1)];
  const min = randomInt(16, 24);

  return {
    date: dateKey,
    label: parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日',
    tasks: tasks,
    devices: devices,
    weather: { code: code, text: WEATHER_CODE_TEXT[code] || '未知', max: min + randomInt(4, 9), min: min },
    demo: true
  };
}

app.post('/api/daily_report_demo', (req, res) => {
  const report = makeDemoDailyReport();
  dailyReports = dailyReports.filter(item => item.date !== report.date);
  dailyReports.unshift(report);
  dailyReports = dailyReports.slice(0, DAILY_REPORT_KEEP_DAYS);
  broadcastLog('[每日报]：已随机生成 ' + report.label + ' 的演示日报');
  broadcastState();
  res.json({ success: true, report: report, reports: dailyReports });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Server running on port ${PORT}`);
});
