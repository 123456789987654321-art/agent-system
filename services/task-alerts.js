const fs = require('node:fs');
const path = require('node:path');

function createTaskAlertStore({ filePath } = {}) {
  let alerts = new Map();
  let unreadable = false;
  if (filePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(saved) || saved.some(alert => !alert || typeof alert.id !== 'string' || typeof alert.text !== 'string')) {
        throw new Error('Invalid task alert archive');
      }
      alerts = new Map(saved.map(alert => [alert.id, alert]));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        unreadable = true;
        console.error('未读提醒存档暂时无法读取，保留原文件：', error.message);
      }
    }
  }
  function persist() {
    if (!filePath || unreadable) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = filePath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify([...alerts.values()]), 'utf8');
    fs.renameSync(temporary, filePath);
  }
  return {
    list: () => [...alerts.values()],
    add(task, text) {
      const alert = { id: task.id, name: task.name, reminder: task.reminder === true, text, occurredAt: Date.now() };
      alerts.set(alert.id, alert);
      try { persist(); } catch (error) { console.error('未读提醒暂未保存到磁盘：', error.message); }
      return alert;
    },
    acknowledge(id) {
      const alert = alerts.get(id);
      if (!alert) return;
      alerts.delete(id);
      try { persist(); } catch (error) { alerts.set(id, alert); throw error; }
    }
  };
}

module.exports = { createTaskAlertStore };
