// Browser audio is injectable so cancellation and real playback events can be tested.
export class AvatarSpeech {
  constructor({ synthesis, Utterance, isEnabled, onSpeech = () => {}, timeout = 30000 }) {
    Object.assign(this, { synthesis, Utterance, isEnabled, onSpeech, timeout });
    this.pending = null;
  }
  get supported() { return !!this.synthesis && typeof this.Utterance === 'function'; }
  get canSpeak() { return this.supported && this.isEnabled(); }
  stop() {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(false); }
    this.onSpeech(false);
    try { this.synthesis?.cancel(); } catch {}
  }
  speak(text) {
    if (!this.isEnabled()) return Promise.reject(new Error('请先保存 API Key。'));
    if (!this.supported) return Promise.reject(new Error('当前浏览器不支持语音播报。'));
    const characters = Array.from(String(text).trim());
    if (!characters.length) return Promise.resolve(false);
    this.stop();
    const chunks = [];
    while (characters.length) chunks.push(characters.splice(0, 100).join(''));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null, utterance: null };
      this.pending = pending;
      const finish = error => {
        if (this.pending !== pending) return;
        this.pending = null;
        clearTimeout(pending.timer);
        this.onSpeech(false);
        if (error) { try { this.synthesis.cancel(); } catch {} reject(error); }
        else resolve(true);
      };
      const next = () => {
        if (this.pending !== pending) return;
        if (!this.isEnabled()) { this.stop(); return; }
        const chunk = chunks.shift();
        if (chunk === undefined) { finish(); return; }
        try {
          const utterance = new this.Utterance(chunk);
          pending.utterance = utterance; // Retain the utterance until the browser finishes it.
          utterance.lang = 'zh-CN';
          utterance.rate = 1;
          utterance.pitch = 1.05;
          const voices = this.synthesis.getVoices();
          const voice = voices.find(v => /^zh[-_]CN$/i.test(v.lang)) || voices.find(v => /^zh/i.test(v.lang));
          if (voice) utterance.voice = voice;
          const current = () => this.pending === pending && pending.utterance === utterance;
          utterance.onstart = () => {
            if (!current()) return;
            if (!this.isEnabled()) { this.stop(); return; }
            this.onSpeech(true);
          };
          utterance.onend = () => {
            if (!current()) return;
            clearTimeout(pending.timer);
            this.onSpeech(false);
            next();
          };
          utterance.onerror = event => {
            if (current()) finish(new Error('语音播报失败：' + (event.error || 'unknown')));
          };
          // Browsers may neither start nor reject a blocked utterance.
          pending.timer = setTimeout(() => finish(new Error('语音播报超时。')), this.timeout);
          this.synthesis.speak(utterance);
        } catch (error) { finish(error); }
      };
      next();
    });
  }
}
