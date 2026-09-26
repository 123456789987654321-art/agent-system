(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskAlerts = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  // Tasks watched by this page remain live across a socket reconnect.
  // History from before opening the page still requires an explicit choice.
  function createController({ speak, acknowledge, canSpeak = () => true, onChange = () => {} }) {
    const pending = new Map();
    const handled = new Set();
    const watched = new Set();
    let speakingId = null;
    const list = () => [...pending.values()].map(item => ({ ...item.task, replayed: item.replayed, speaking: item.task.id === speakingId, error: item.error }));
    const notify = () => onChange(list());
    function remove(id) {
      handled.add(id);
      watched.delete(id);
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
      item.retryable = false;
      item.error = '';
      speakingId = id;
      notify();
      let completed = false;
      let failure = '';
      try {
        completed = await speak(item.task.text || ('提醒时间到了，该' + item.task.name + '了。')) === true;
        if (completed) await complete(id);
      } catch (error) { failure = error?.message || ''; }
      finally {
        if (!completed && pending.has(id)) {
          item.error = '未完成播报，' + (failure || '播放被中断，可点击播报重试');
          item.retryable = !item.replayed;
        }
        speakingId = null;
        notify();
        void drain();
      }
      return completed;
    }
    async function drain() {
      if (speakingId || !canSpeak()) return;
      const item = [...pending.values()].find(item => item.automatic);
      if (item) await play(item.task.id);
    }
    return {
      list,
      observeTasks(state) {
        for (const task of [state?.activeTask, ...(state?.pendingTasks || [])]) {
          if (task?.id && !handled.has(task.id)) watched.add(task.id);
        }
      },
      receive(task, { replayed = false } = {}) {
        if (!task?.id || handled.has(task.id) || pending.has(task.id)) return;
        watched.delete(task.id);
        pending.set(task.id, { task, replayed, automatic: !replayed, retryable: false, error: '' });
        notify();
        if (!replayed) void drain();
      },
      restore(tasks) {
        for (const task of Array.isArray(tasks) ? tasks : []) this.receive(task, { replayed: !watched.has(task?.id) });
      },
      resume: drain,
      retryFailed() {
        for (const item of pending.values()) {
          if (item.retryable) { item.automatic = true; item.retryable = false; }
        }
        return drain();
      },
      speakNext(id = pending.keys().next().value) { return id ? play(id) : Promise.resolve(false); },
      async dismissNext(id = pending.keys().next().value) {
        if (pending.has(id) && id !== speakingId) await complete(id);
      },
      remove
    };
  }
  return { createController };
});
