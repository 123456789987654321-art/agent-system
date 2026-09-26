(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskAlerts = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  // Only live messages enter the automatic queue. Restored alerts require a choice.
  function createController({ speak, acknowledge, onChange = () => {} }) {
    const pending = new Map();
    const handled = new Set();
    let speakingId = null;
    const list = () => [...pending.values()].map(item => ({ ...item.task, replayed: item.replayed, speaking: item.task.id === speakingId, error: item.error }));
    const notify = () => onChange(list());
    function remove(id) {
      handled.add(id);
      pending.delete(id);
      notify();
    }
    async function complete(id) {
      try {
        await acknowledge(id);
        remove(id);
      } catch {
        const item = pending.get(id);
        if (item) item.error = '处理状态未同步，请重试';
        notify();
      }
    }
    async function play(id) {
      if (speakingId || !pending.has(id)) return false;
      const item = pending.get(id);
      item.automatic = false;
      item.error = '';
      speakingId = id;
      notify();
      let completed = false;
      try {
        completed = await speak(item.task.text || ('提醒时间到了，该' + item.task.name + '了。')) === true;
        if (completed) await complete(id);
      } catch { /* Keep blocked, interrupted or failed speech available for retry. */ }
      finally {
        if (!completed && pending.has(id)) item.error = '未完成播报，可点击播报重试';
        speakingId = null;
        notify();
        void drain();
      }
      return completed;
    }
    async function drain() {
      if (speakingId) return;
      const item = [...pending.values()].find(item => item.automatic);
      if (item) await play(item.task.id);
    }
    return {
      list,
      receive(task, { replayed = false } = {}) {
        if (!task?.id || handled.has(task.id) || pending.has(task.id)) return;
        pending.set(task.id, { task, replayed, automatic: !replayed, error: '' });
        notify();
        if (!replayed) void drain();
      },
      restore(tasks) {
        for (const task of Array.isArray(tasks) ? tasks : []) this.receive(task, { replayed: true });
      },
      speakNext() { const first = pending.keys().next().value; return first ? play(first) : Promise.resolve(false); },
      async dismissNext() {
        const first = pending.keys().next().value;
        if (first && first !== speakingId) await complete(first);
      },
      remove
    };
  }
  return { createController };
});
