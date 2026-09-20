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

// 状态机与任务记忆库 (全面扩充设备列表，默认关闭)
let homeState = {
  personHome: false,
  devices: { 
    door_main: '关闭', door_bedroom: '关闭', door_toilet: '关闭', door_balcony: '关闭',
    light_living: '关闭', light_bedroom: '关闭', light_kitchen: '关闭', light_toilet: '关闭', light_balcony: '关闭',
    window_living: '关闭', window_bedroom: '关闭', window_kitchen: '关闭',
    ac: '关闭', water_heater: '关闭', kettle: '关闭', washer: '关闭', tv: '关闭', fan: '关闭'
  },
  activeTask: null,
  pendingTasks: []
};

// 任务心跳检测
setInterval(() => {
  if (homeState.activeTask) {
    homeState.activeTask.remaining--;
    if (homeState.activeTask.remaining <= 0) {
      broadcastLog(`[任务完成]：${homeState.activeTask.name} 结束`);
      homeState.activeTask = null;
    }
  }
  activateReadyTask();
  broadcastState();
}, 1000);

function broadcastState() {
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'STATE_UPDATE', data: homeState })));
}
function broadcastLog(logText) {
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(JSON.stringify({ type: 'AGENT_LOG', log: logText })));
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
  const scheduledTime = String(action.scheduledTime || '').trim();
  const executeMode = action.execute === 'scheduled' || scheduledTime ? 'scheduled' : 'now';
  const scheduledAt = executeMode === 'scheduled'
    ? parseScheduledAt(scheduledTime)
    : Date.now();

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: String(action.name || '日常任务'),
    totalSeconds: minutes * 60,
    remaining: minutes * 60,
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
  const systemPrompt = `你是一个智能家居Agent。用户指令："${userInput}"
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
        result.actions.forEach(action => {
          if (action.type === 'control' && Object.prototype.hasOwnProperty.call(homeState.devices, action.device)) {
            homeState.devices[action.device] = action.state;
          } else if (action.type === 'set_task') {
            scheduleTask(action);
          }
        });
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
  const { name, minutes, execute, scheduledTime } = req.body;
  if (!name) return res.status(400).json({ error: '任务名称不能为空' });

  const task = scheduleTask({
    type: 'set_task',
    name,
    minutes,
    execute,
    scheduledTime
  });
  broadcastLog(`[任务安排]：${task.name}，${task.executeMode === 'now' ? '立即执行' : `${task.scheduledTime} 执行`}`);
  broadcastState();
  res.json({ success: true, task });
});

// 前端手动点击控制开关的 API
app.post('/api/toggle_device', (req, res) => {
  const { device, state } = req.body;
  if (homeState.devices[device] !== undefined) {
    homeState.devices[device] = state;
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Server running on port ${PORT}`);
});
