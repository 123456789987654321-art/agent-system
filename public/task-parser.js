(function (root, factory) {
  const parser = factory();
  if (typeof module === 'object' && module.exports) module.exports = parser;
  else root.TaskParser = parser;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const TASK_PRESETS = {
    '倒垃圾': 10, '晒衣服': 30, '晾衣服': 30, '收衣服': 10, '洗衣服': 45,
    '浇花': 10, '拖地': 20, '扫地': 20, '洗碗': 15, '擦桌子': 10, '整理房间': 30
  };
  const NUMBER = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万]+|半)';
  const UNIT = '(?:秒钟|秒|seconds|second|secs|sec|s|minutes|minute|mins|min|分钟|分|hours|hour|hrs|hr|小时|钟头|h)';
  const REMINDER = /提醒我一下|提醒我|提醒你|提醒一下|提醒|记得|叫我|通知我|告诉我/;

  function parseNumber(text) {
    if (text === '半') return 0.5;
    if (/^\d/.test(text)) return Number(text);
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!/[十百千万]/.test(text)) return Number([...text].map(char => digits[char]).join(''));
    let total = 0, section = 0, digit = 0;
    for (const char of text) {
      if (char in digits) digit = digits[char];
      else if (char === '万') { total += (section + digit) * 10000; section = 0; digit = 0; }
      else { section += (digit || 1) * ({ 十: 10, 百: 100, 千: 1000 }[char]); digit = 0; }
    }
    return total + section + digit;
  }

  function parseRelativeDelay(text) {
    const compact = String(text || '').replace(/\s+/g, '');
    const pattern = new RegExp(`(${NUMBER})个?(半)?(${UNIT})(半)?`, 'gi');
    const first = pattern.exec(compact);
    if (!first) return null;
    let match = first, end = first.index, seconds = 0;
    do {
      const unit = match[3].toLowerCase();
      const factor = /^(秒|s)/.test(unit) ? 1 : /^(分|min)/.test(unit) ? 60 : 3600;
      seconds += (parseNumber(match[1]) + (match[2] || match[4] ? 0.5 : 0)) * factor;
      end = pattern.lastIndex;
      match = pattern.exec(compact);
    } while (match && match.index === end);
    const after = compact.slice(end).match(/^(之后|以后|后)/)?.[0] || '';
    return {
      seconds: Math.round(seconds), raw: compact.slice(first.index, end),
      hasAfter: Boolean(after), index: first.index, text: compact.slice(first.index, end) + after
    };
  }

  // Split action scopes, preserving a reminder's contents (including device names).
  function splitCommandClauses(text) {
    const pieces = String(text || '').replace(/\s+/g, '')
      .replace(/["'“”‘’]/g, '')
      .split(/(?:[，,；;。！？!?]+|然后|接着|随后|并且|同时)/).filter(Boolean);
    const clauses = [];
    for (const piece of pieces) {
      const previous = clauses.at(-1);
      const delay = previous && parseRelativeDelay(previous);
      const timeOnly = delay && previous.replace(delay.text, '').replace(/^(请|麻烦|帮我)+/, '') === '';
      const reminderOnly = previous && previous.replace(REMINDER, '').replace(/^(请|麻烦|帮我)+/, '') === '';
      if (timeOnly || reminderOnly) clauses[clauses.length - 1] += piece;
      else clauses.push(piece);
    }
    return clauses;
  }

  function parseTaskCommand(text) {
    const compact = String(text || '').replace(/\s+/g, '').replace(/["'“”‘’]/g, '');
    const reminder = REMINDER.test(compact);
    const delay = parseRelativeDelay(compact);
    const preset = Object.keys(TASK_PRESETS).find(name => compact.includes(name));
    if (!reminder && !preset) return null;
    // Never turn an unspecified/invalid reminder into a default chore timer.
    if (delay && delay.seconds <= 0) return { error: '请提供大于零的提醒或计时时长。' };
    if (delay && (reminder || delay.hasAfter)) {
      const name = compact.replace(delay.text, '').replace(REMINDER, '')
        .replace(/^(请|麻烦|帮我|给我|替我|到时候|记得|我|一下|去|要|该)+/, '')
        .replace(/[，。！？、,.!?;；]/g, '').replace(/[吧啊]$/, '');
      if (!name) return { error: '请说明到时间后需要提醒你做什么。' };
      return { type: 'set_task', name, seconds: delay.seconds, execute: 'now', scheduledTime: '', reminder: true,
        speak: `好的，${delay.raw}后提醒你${name}。` };
    }

    const time = compact.match(/(今天|明天)?(上午|下午|晚上)?(\d{1,2})(?:点|:|：)(\d{1,2})?/);
    let scheduledTime = '', execute = 'now';
    if (time) {
      let hour = Number(time[3]);
      const minute = Number(time[4] || 0);
      if ((time[2] === '下午' || time[2] === '晚上') && hour < 12) hour += 12;
      if (hour > 23 || minute > 59) return { error: '请提供有效的提醒时间。' };
      scheduledTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      execute = 'scheduled';
    } else if (/稍后|待会|等会|晚点|一会儿/.test(compact)) {
      scheduledTime = '稍后'; execute = 'scheduled';
    }
    if (reminder && !scheduledTime) return { error: '请说明多久以后或几点提醒你，例如“五分钟后提醒我倒垃圾”。' };
    if (reminder) {
      const name = compact.replace(time ? time[0] : /稍后|待会|等会|晚点|一会儿/, '')
        .replace(REMINDER, '').replace(/^(请|麻烦|帮我|我|去|要)+/, '').replace(/[吧啊]$/, '');
      if (!name) return { error: '请说明到时间后需要提醒你做什么。' };
      return { type: 'set_task', name, reminder: true, execute, scheduledTime, dayOffset: time?.[1] === '明天' ? 1 : 0,
        speak: `好的，已安排${time?.[1] || ''}${scheduledTime}提醒你${name}。` };
    }
    const name = preset === '晾衣服' ? '晒衣服' : preset;
    return { type: 'set_task', name, minutes: TASK_PRESETS[preset], seconds: delay?.seconds,
      reminder: false, execute, scheduledTime, dayOffset: time?.[1] === '明天' ? 1 : 0,
      speak: execute === 'scheduled' ? `好的，已安排在${scheduledTime}执行${name}。` : `好的，现在开始${name}计时。` };
  }

  return { parseRelativeDelay, splitCommandClauses, parseTaskCommand };
});
