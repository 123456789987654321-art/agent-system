import { AvatarSpeech } from './avatar-speech.mjs?v=avatar2d-20260926-1';

const stage = document.getElementById('avatarStage');
const host = document.getElementById('avatar-2d');
const caption = stage.querySelector('.avatar-caption');
const enabled = () => typeof window.isAgentOffline === 'function' && !window.isAgentOffline();
const speech = new AvatarSpeech({
  synthesis: window.speechSynthesis,
  Utterance: window.SpeechSynthesisUtterance,
  isEnabled: enabled,
  onSpeech: active => stage.classList.toggle('speaking', active),
});
function syncAccess() {
  const active = enabled();
  stage.classList.toggle('avatar-enabled', active);
  if (!active) {
    speech.stop();
    stage.classList.remove('listening');
  }
}
function resize() {
  const space = caption.offsetHeight + 20 + 'px';
  if (stage.style.getPropertyValue('--avatar-caption-space') !== space) stage.style.setProperty('--avatar-caption-space', space);
  const compact = host.clientHeight > 0 && host.clientHeight < 180;
  stage.classList.toggle('avatar-compact', compact);
  const viewBox = compact ? '85 30 250 340' : '0 0 420 440';
  const portrait = host.querySelector('svg');
  if (portrait.getAttribute('viewBox') !== viewBox) portrait.setAttribute('viewBox', viewBox);
}
window.HomeAvatar = {
  get ready() { return !!host.querySelector('svg'); },
  get canSpeak() { return speech.canSpeak; },
  speak: text => speech.speak(text),
  stopSpeech: () => speech.stop(),
  syncAccess,
};
let resizeFrame = 0;
const observer = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(resize);
});
observer.observe(host);
observer.observe(caption);
window.addEventListener('pagehide', () => speech.stop());
document.addEventListener('visibilitychange', () => { if (document.hidden) speech.stop(); });
resize();
syncAccess();
window.updateAgentConnectionState?.();
window.DailyReport?.updateSpeechButtons();
