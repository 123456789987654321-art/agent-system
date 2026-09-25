/* Daily reports use recorded events; no model key is needed. */
window.DailyReport = (() => {
  let data = null;
  let requestVersion = 0;
  let refreshTimer = null;
  let speechVersion = 0;
  let speaking = false;
  let currentUtterance = null;
  let speechText = '';
  let lastWeather = null;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const isOpen = () => document.getElementById('page-report').classList.contains('active');
  const clock = value => new Date(value).toLocaleTimeString('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  const dateTime = value => new Date(value).toLocaleString('zh-CN', { timeZone, hour12: false });
  const escape = value => escapeHtml(value);
  const duration = seconds => seconds >= 60 ? `${Math.ceil(seconds / 60)} 分钟` : `${Math.max(0, Math.ceil(seconds))} 秒`;

  function eventText(event) {
    const name = String(event.name || '未命名任务');
    switch (event.type) {
      case 'device_changed': return `${name}：${event.state}（系统状态）`;
      case 'task_created': return `安排${event.reminder ? '提醒' : '任务'}「${name}」`;
      case 'task_started': return `开始${event.reminder ? '提醒倒计时' : '任务计时'}「${name}」`;
      case 'task_finished': return `「${name}」计时结束`;
      case 'reminder_due': return `提醒到点：「${name}」`;
      case 'task_cancelled': return `取消「${name}」`;
      case 'task_paused': return `暂停「${name}」`;
      case 'task_resumed': return `继续「${name}」`;
      case 'task_extended': return `「${name}」延长 ${duration(event.seconds)}`;
      case 'task_advanced': return `「${name}」提前 ${duration(event.seconds)}`;
      case 'task_rescheduled': return `调整「${name}」的开始时间`;
      default: return name;
    }
  }

  function weatherText(snapshot) {
    if (!snapshot || Date.now() - snapshot.fetchedAt >= 5 * 60 * 1000
      || snapshot.locationVersion !== weatherLocationVersion
      || ![snapshot.currentTemp, snapshot.minTemp, snapshot.maxTemp].every(Number.isFinite)) {
      return '暂未获取到当前位置的有效天气数据。允许定位并更新天气后，这里会自动补充。';
    }
    const source = snapshot.source === 'ip' ? '按网络大致位置查询' : '按当前位置查询';
    return `今天${getWeatherInfo(snapshot.dailyCode).text}，最低 ${Math.round(snapshot.minTemp)}℃，最高 ${Math.round(snapshot.maxTemp)}℃。当前${getWeatherInfo(snapshot.currentCode).text}，气温 ${Math.round(snapshot.currentTemp)}℃。${source}，数据时间：${String(snapshot.dataTime || '暂未提供').replace('T', ' ')}。`;
  }

  function render() {
    if (!data) return;
    const { counts, events, activeTask, pendingTasks } = data;
    const finished = events.filter(event => event.type === 'task_finished');
    const names = [...new Set(finished.map(event => event.name))];
    const finishedNames = names.slice(0, 6).join('、') + (names.length > 6 ? '等' : '');
    const summary = events.length
      ? `截至 ${clock(data.generatedAt)}，今天记录了 ${counts.tasksCreated} 项新任务，${counts.tasksFinished} 项任务计时结束，${counts.remindersDue} 条提醒到点，以及 ${counts.deviceChanges} 次设备状态变更。`
      : '';
    let taskText = finished.length ? `已结束计时的任务包括：${finishedNames}。` : '今天暂时没有任务计时结束。';
    if (activeTask) taskText += `当前${activeTask.paused ? '已暂停' : '正在进行'}${activeTask.reminder ? '提醒' : '任务'}「${activeTask.name}」，剩余约 ${duration(activeTask.remaining)}。`;
    else taskText += '目前没有正在计时的任务。';
    if (pendingTasks.length) {
      const next = pendingTasks[0];
      taskText += `另有 ${pendingTasks.length} 项安排等待执行，下一项为「${next.name}」，计划时间 ${dateTime(next.scheduledAt)}；如有任务正在执行，将按队列顺序开始。`;
    }
    const deviceText = counts.deviceChanges
      ? `今天共记录 ${counts.deviceChanges} 次设备状态变更。目前系统中有 ${data.devicesOn} 个设备处于开启状态，具体操作见下方活动记录。`
      : `今天尚无设备状态变更记录。目前系统中有 ${data.devicesOn} 个设备处于开启状态。`;
    const weather = weatherText(lastWeather);
    const note = '任务计时结束不代表家务已实际完成；设备操作反映系统记录的状态。报告从记录功能启用后开始积累。';
    const groups = [['今日天气', weather], ['任务与提醒', taskText], ['家电使用', deviceText]];
    const timelineEvents = events.slice(-100).reverse();
    const timeline = timelineEvents.length
      ? `<ol class="report-timeline">${timelineEvents.map(event => `<li><time>${escape(clock(event.at))}</time><span>${escape(eventText(event))}</span></li>`).join('')}</ol>`
      : '<p class="report-empty">暂无活动记录，今天的安排从这里开始。</p>';
    const content = `<div class="report-reading-header"><h2>${escape(data.date)} 居家日报</h2><p class="report-meta">更新于 ${escape(clock(data.generatedAt))}</p></div>
      ${summary ? `<p class="report-summary">${escape(summary)}</p>` : ''}
      <div class="report-sections">${groups.map(([title, text]) => `<section><h3>${title}</h3><p>${escape(text)}</p></section>`).join('')}</div>
      <section class="report-activity"><h3>今日活动记录 <span>${events.length} 条${events.length > 100 ? ' · 展示最近 100 条' : ''}</span></h3>${timeline}</section>
      <p class="report-note">${escape(note)}<br>开始记录：${escape(dateTime(data.trackingStartedAt))}${data.storageWarning ? `<br>${escape(data.storageWarning)}` : ''}</p>`;
    for (const id of ['reportContent', 'reportExpandedContent']) document.getElementById(id).innerHTML = content;
    const labels = [['今日安排', counts.tasksCreated, '项'], ['计时结束', counts.tasksFinished, '项'], ['提醒到点', counts.remindersDue, '条'], ['设备操作', counts.deviceChanges, '次']];
    document.getElementById('reportStats').innerHTML = labels.map(([label, count, unit]) => `<div class="report-stat"><span>${label}</span><strong>${count}<small> ${unit}</small></strong></div>`).join('');
    // Read the same content shown on screen, including the visible activity log.
    speechText = `${data.date}，居家日报。${summary}\n${groups.map(([title, text]) => `${title}。${text}`).join('\n')}\n今日活动记录。${timelineEvents.length ? timelineEvents.map(event => `${clock(event.at)}，${eventText(event)}。`).join('\n') : '暂无活动记录。'}${events.length > 100 ? '以上为最近一百条活动。' : ''}\n${note}`;
    document.querySelectorAll('[data-report-action]').forEach(button => { button.disabled = false; });
  }

  async function refresh() {
    const version = ++requestVersion;
    stopSpeech();
    const status = document.getElementById('reportStatus');
    status.textContent = '正在整理今日记录…';
    try {
      const result = await fetchJsonWithTimeout('/api/report/today?timeZone=' + encodeURIComponent(timeZone));
      if (version !== requestVersion) return;
      data = result;
      lastWeather = todayWeatherSnapshot;
      render();
      status.textContent = '已根据系统记录更新';
      // Activity data stays available even if weather or geolocation is unavailable.
      const snapshot = await getTodayWeatherSnapshot();
      if (version !== requestVersion) return;
      lastWeather = snapshot;
      if (!speaking) render();
    } catch (error) {
      if (version !== requestVersion) return;
      status.textContent = data ? '更新失败，当前显示上次生成的报告。请稍后刷新。' : '报告加载失败，请检查连接后点击刷新。';
    }
  }

  function invalidate() {
    if (!isOpen() || speaking) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 400);
  }

  function updateSpeechButtons() {
    document.querySelectorAll('[data-report-speak]').forEach(button => {
      button.setAttribute('aria-pressed', String(speaking));
      button.querySelector('span').textContent = speaking ? '停止播报' : '语音播报';
    });
  }

  function stopSpeech() {
    speechVersion++;
    if (speaking && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    speaking = false;
    currentUtterance = null;
    updateSpeechButtons();
  }

  function speak() {
    if (speaking) { stopSpeech(); return; }
    if (!speechText) return;
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      document.getElementById('reportStatus').textContent = '当前浏览器不支持语音播报，请使用支持语音合成的浏览器。';
      return;
    }
    window.speechSynthesis.cancel();
    const token = ++speechVersion;
    const chunks = (speechText.match(/[^。！？；\n]+[。！？；\n]?/g) || [speechText]).flatMap(sentence => sentence.match(/[\s\S]{1,160}/g) || []);
    speaking = true;
    updateSpeechButtons();
    const next = () => {
      if (token !== speechVersion) return;
      const text = chunks.shift();
      if (!text) { stopSpeech(); document.getElementById('reportStatus').textContent = '报告播报完毕'; return; }
      currentUtterance = new SpeechSynthesisUtterance(text);
      currentUtterance.lang = 'zh-CN';
      currentUtterance.rate = 1;
      currentUtterance.onend = next;
      currentUtterance.onerror = () => {
        if (token !== speechVersion) return;
        stopSpeech();
        document.getElementById('reportStatus').textContent = '播报已中断，可再次点击语音播报重试。';
      };
      window.speechSynthesis.speak(currentUtterance);
    };
    document.getElementById('reportStatus').textContent = '正在播报，可再次点击按钮停止';
    next();
  }

  function expand() {
    if (data) document.getElementById('reportDialog').showModal();
  }
  function close() { document.getElementById('reportDialog').close(); }
  function leave() {
    requestVersion++;
    clearTimeout(refreshTimer);
    stopSpeech();
    close();
  }
  document.getElementById('reportDialog').addEventListener('close', stopSpeech);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopSpeech();
    else if (isOpen()) refresh();
  });
  setInterval(() => { if (isOpen() && document.visibilityState !== 'hidden' && !speaking) refresh(); }, 60000);
  return { open: refresh, refresh, invalidate, speak, stopSpeech, expand, close, leave };
})();
