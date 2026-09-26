import { AvatarSpeech } from './avatar-speech.mjs?v=avatar25d-20260926-1';

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
    resetDepth();
  }
}
function resize() {
  const space = caption.offsetHeight + 20 + 'px';
  if (stage.style.getPropertyValue('--avatar-caption-space') !== space) stage.style.setProperty('--avatar-caption-space', space);
  const compact = host.clientHeight > 0 && host.clientHeight < 180;
  stage.classList.toggle('avatar-compact', compact);
  const viewBox = compact ? '100 25 220 300' : '0 0 420 500';
  const portrait = host.querySelector('svg');
  if (portrait.getAttribute('viewBox') !== viewBox) portrait.setAttribute('viewBox', viewBox);
}
function resetDepth() {
  host.style.removeProperty('--portrait-x');
  host.style.removeProperty('--portrait-y');
}
// Small layer offsets suggest depth without distorting facial anatomy or arm joints.
stage.addEventListener('pointermove', event => {
  if (!enabled() || event.pointerType !== 'mouse' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = stage.getBoundingClientRect();
  const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
  const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
  host.style.setProperty('--portrait-x', (x * 2.5).toFixed(2) + 'px');
  host.style.setProperty('--portrait-y', (y * 1.5).toFixed(2) + 'px');
});
stage.addEventListener('pointerleave', resetDepth);
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
