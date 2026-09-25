const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const EVENT_TYPES = new Set(['device_changed', 'task_created', 'task_started', 'task_finished', 'reminder_due', 'task_cancelled', 'task_paused', 'task_resumed', 'task_extended', 'task_advanced', 'task_rescheduled']);

function dayKey(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function createDailyReportStore({ filePath, now = Date.now } = {}) {
  let events = [];
  let trackingStartedAt = now();
  let storageWarning = '';
  let unreadable = false;
  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(saved.events) || !Number.isFinite(saved.trackingStartedAt)) throw new Error('Invalid report archive');
      events = saved.events.filter(event => EVENT_TYPES.has(event.type) && Number.isFinite(event.at));
      trackingStartedAt = saved.trackingStartedAt;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        unreadable = true;
        storageWarning = '历史记录暂时无法读取，本报告仅包含本次启动后的记录。';
      }
    }
  }
  function persist() {
    if (!filePath || unreadable) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = filePath + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify({ trackingStartedAt, events }), 'utf8');
      fs.renameSync(temporary, filePath);
      storageWarning = '';
    } catch (error) {
      storageWarning = '记录暂未保存到磁盘，服务重启后可能丢失。';
    }
  }
  function trim() {
    events = events.filter(event => event.at >= now() - 31 * 24 * 60 * 60 * 1000);
  }
  trim();
  persist();
  return {
    record(type, details = {}) {
      if (!EVENT_TYPES.has(type)) throw new Error('Unsupported report event');
      // Retain only report fields, never user credentials or model payloads.
      const event = { id: randomUUID(), at: now(), type };
      for (const key of ['taskId', 'name', 'device', 'state', 'scheduledAt', 'seconds', 'reminder']) {
        if (details[key] !== undefined) event[key] = details[key];
      }
      events.push(event);
      trim();
      persist();
      return event;
    },
    today(timeZone = 'Asia/Shanghai', homeState = {}) {
      const generatedAt = now();
      const date = dayKey(generatedAt, timeZone);
      const todayEvents = events.filter(event => dayKey(event.at, timeZone) === date);
      const taskView = task => task ? {
        id: task.id, name: task.name, reminder: task.reminder === true,
        paused: task.paused === true, remaining: task.remaining, scheduledAt: task.scheduledAt
      } : null;
      return {
        date, timeZone, generatedAt, trackingStartedAt, storageWarning,
        counts: {
          tasksCreated: todayEvents.filter(event => event.type === 'task_created' && !event.reminder).length,
          tasksFinished: todayEvents.filter(event => event.type === 'task_finished').length,
          remindersDue: todayEvents.filter(event => event.type === 'reminder_due').length,
          deviceChanges: todayEvents.filter(event => event.type === 'device_changed').length
        },
        events: todayEvents,
        activeTask: taskView(homeState.activeTask),
        pendingTasks: (homeState.pendingTasks || []).map(taskView),
        devicesOn: Object.values(homeState.devices || {}).filter(value => value === '开启').length
      };
    }
  };
}

module.exports = { createDailyReportStore, dayKey };
