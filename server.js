require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const { createAddressLookup } = require('./services/location-address');
const lookupAddress = createAddressLookup();

const app = express();
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));
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
  pendingTasks: []
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

function finishTask(task) {
  if (!task) return;
  const text = task.reminder ? '现在要去' + task.name + '了' : task.name + '任务已完成';
  homeState.activeTask = null;
  broadcastLog('[任务完成]：' + task.name + ' 结束');
  broadcastTaskDone(task, text);
  broadcastState();
}

// 统一写入设备状态。
function applyDeviceState(deviceKey, state) {
  homeState.devices[deviceKey] = state;
}

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

// 同站点地址解析，避免要求访问者的浏览器直接连接外部地理服务。
app.get('/api/location/address', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { lat, lon } = req.query;
  if (typeof lat !== 'string' || typeof lon !== 'string' || !lat.trim() || !lon.trim()) {
    return res.status(400).json({ error: '无效的定位坐标' });
  }
  try {
    const address = await lookupAddress(Number(lat), Number(lon));
    res.json({ address });
  } catch (error) {
    const status = error.statusCode || 502;
    if (status === 429) res.set('Retry-After', '1');
    res.status(status).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Server running on port ${PORT}`);
});
